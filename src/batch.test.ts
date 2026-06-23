import { describe, expect, test } from "bun:test";
import { parseArgs, parseJsonl, mapPool, extractItem } from "./batch";
import type { InterconnectionStudy } from "./schema";

const rec = (o: Record<string, unknown>) => o as unknown as InterconnectionStudy;

describe("parseArgs", () => {
  test("parses a path with --flag value pairs", () => {
    const a = parseArgs(["data/cases", "--out", "r.jsonl", "--concurrency", "8"]);
    expect(a.path).toBe("data/cases");
    expect(a.out).toBe("r.jsonl");
    expect(a.concurrency).toBe(8);
  });

  test("supports the --flag=value form", () => {
    const a = parseArgs(["dir", "--out=r.jsonl", "--threshold=0.5"]);
    expect(a.out).toBe("r.jsonl");
    expect(a.threshold).toBe(0.5);
  });

  test("a value-less flag throws instead of silently eating the next flag", () => {
    // the old fixed-pair parser dropped --out entirely here; now it's explicit
    expect(() => parseArgs(["dir", "--out", "--concurrency", "8"])).toThrow(/--out needs a value/);
  });

  test("a stray positional is rejected, not silently consumed as a value", () => {
    expect(() => parseArgs(["dir", "stray", "--out", "r.jsonl"])).toThrow(/unexpected argument/);
  });

  test("--threshold 0 is honored (not swallowed by a falsy-OR default)", () => {
    // the original `parseFloat(...) || 0.67` turned a requested 0 back into 0.67
    expect(parseArgs(["dir", "--threshold", "0"]).threshold).toBe(0);
  });

  test("threshold is clamped to [0,1]", () => {
    expect(parseArgs(["dir", "--threshold", "1.5"]).threshold).toBe(1);
    expect(parseArgs(["dir", "--threshold", "-1"]).threshold).toBe(0);
  });

  test("non-numeric numerics fall back to their defaults", () => {
    const a = parseArgs(["dir", "--threshold", "abc", "--concurrency", "xyz"]);
    expect(a.threshold).toBe(0.67);
    expect(a.concurrency).toBe(4);
  });

  test("concurrency and confidence are floored at 1", () => {
    const a = parseArgs(["dir", "--concurrency", "0", "--confidence", "0"]);
    expect(a.concurrency).toBe(1);
    expect(a.confidence).toBe(1);
  });

  test("absent flags take their defaults", () => {
    const a = parseArgs(["dir"]);
    expect(a).toMatchObject({ path: "dir", concurrency: 4, confidence: 1, threshold: 0.67 });
    expect(a.out).toBeUndefined();
    expect(a.review).toBeUndefined();
  });
});

describe("parseJsonl", () => {
  test("parses one object per line, deriving a line-based id when absent", () => {
    const { items, skipped } = parseJsonl('{"input":"a"}\n{"id":"x","text":"b"}\n');
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { id: "line-1", input: "a" },
      { id: "x", input: "b" },
    ]);
  });

  test("a derived id can't collide with an explicit sequential id elsewhere in the file", () => {
    // {"id":"2"} then an id-less line previously both became "2"; now the id-less
    // line is keyed by its line number, so output ids stay unique.
    const { items } = parseJsonl('{"id":"2","input":"a"}\n{"input":"b"}\n');
    expect(items.map((i) => i.id)).toEqual(["2", "line-2"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length); // all ids distinct
  });

  test("ignores blank lines without counting them as malformed", () => {
    const { items, skipped } = parseJsonl("\n  \n{\"input\":\"a\"}\n");
    expect(items).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  test("skips a malformed line by line number instead of aborting the run", () => {
    const { items, skipped } = parseJsonl('{"input":"a"}\n{bad json\n{"input":"c"}\n');
    expect(items.map((i) => i.input)).toEqual(["a", "c"]);
    expect(skipped).toEqual([2]); // 1-based line number of the bad line
  });

  test("falls back from input to text", () => {
    const { items } = parseJsonl('{"text":"hello"}');
    expect(items[0]).toEqual({ id: "line-1", input: "hello" });
  });
});

describe("mapPool", () => {
  test("preserves input order even when tasks finish out of order", async () => {
    // index 0 sleeps longest, index 3 finishes first; results must still be [0,1,2,3]
    const out = await mapPool([30, 10, 20, 0], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  test("never exceeds the concurrency limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("a limit of 0 still runs every item (no silent un-run holes)", async () => {
    // a computed limit of 0 must not spawn zero workers and return an array of holes
    const out = await mapPool([1, 2, 3], 0, async (x) => x * 2);
    expect(out).toEqual([2, 4, 6]);
  });

  test("an empty input returns an empty result", async () => {
    let called = false;
    const out = await mapPool([], 4, async () => {
      called = true;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

// Inject fake extract functions so record shaping is tested with no network/spend.
describe("extractItem", () => {
  const item = { id: "doc-1", input: "text" };
  const never = async () => {
    throw new Error("should not be called");
  };

  test("a single-run success becomes an ok record carrying usage and latency", async () => {
    const deps = {
      extract: async () => ({ ok: true as const, data: rec({ project_name: "X" }), attempts: 1, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, latency_ms: 42 }),
      extractWithConfidence: never,
    };
    const out = await extractItem(item, { confidence: 1, threshold: 0.67 }, deps);
    expect(out).toMatchObject({ id: "doc-1", ok: true, usage: { input_tokens: 10, output_tokens: 5 }, latency_ms: 42 });
    expect(out.data).toMatchObject({ project_name: "X" });
  });

  test("a failed extraction becomes an error record, not a throw", async () => {
    const deps = {
      extract: async () => ({ ok: false as const, error: "schema miss", attempts: 3, model: "m" }),
      extractWithConfidence: never,
    };
    expect(await extractItem(item, { confidence: 1, threshold: 0.67 }, deps)).toMatchObject({ id: "doc-1", ok: false, error: "schema miss" });
  });

  test("an unexpected throw is caught as an error record so one bad doc can't abort the batch", async () => {
    const deps = {
      extract: async () => {
        throw new Error("kaboom");
      },
      extractWithConfidence: never,
    };
    expect(await extractItem(item, { confidence: 1, threshold: 0.67 }, deps)).toMatchObject({ id: "doc-1", ok: false, error: "kaboom" });
  });

  test("confidence>1 routes through the vote and carries the confidence fields", async () => {
    const deps = {
      extract: never,
      extractWithConfidence: async () => ({ ok: true as const, data: rec({ project_name: "X" }), confidence: { project_name: 1 }, low_confidence: ["capacity_mw"], runs: 3, ok_runs: 3, usage: { input_tokens: 30, output_tokens: 15 } }),
    };
    const out = await extractItem(item, { confidence: 3, threshold: 0.67 }, deps);
    expect(out).toMatchObject({ id: "doc-1", ok: true, confidence: { project_name: 1 }, low_confidence: ["capacity_mw"] });
  });
});
