import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cachedExtract, fixtureKey, fixturePath, FIXTURES_DIR } from "./fixtures";

// fixtureKey is the cache key the whole offline replay path depends on
// (cachedExtract does existsSync(fixturePath(...))). If its derivation drifts,
// every committed fixture is orphaned and the harness silently falls through to
// a live, billed call -- so these pin both the behavior and the exact value.
describe("fixtureKey", () => {
  test("is deterministic for the same (model, input, run)", () => {
    const a = fixtureKey("claude-opus-4-8", "doc text", 0);
    expect(a).toBe(fixtureKey("claude-opus-4-8", "doc text", 0));
    // Golden value: pins the exact derivation. It must only change alongside a
    // deliberate re-record of the fixture set, never by accident.
    expect(a).toBe("claude-opus-4-8__aaae66a1a4257e64");
  });

  test("different run indices key to different fixtures", () => {
    // variance mode (RUNS>1) records N distinct draws; run 1 must not clobber run 0
    expect(fixtureKey("m", "doc", 0)).not.toBe(fixtureKey("m", "doc", 1));
  });

  test("different inputs key to different fixtures", () => {
    expect(fixtureKey("m", "doc A", 0)).not.toBe(fixtureKey("m", "doc B", 0));
  });

  test("the model is part of the key (no cross-model fixture reuse)", () => {
    // switching MODEL must not replay another model's recorded output
    expect(fixtureKey("claude-opus-4-8", "doc", 0)).not.toBe(fixtureKey("claude-haiku-4-5", "doc", 0));
  });

  test("sanitizes the model into a filesystem-safe segment", () => {
    // a vendor id like 'vendor/Model:v2' must not introduce path separators or spaces
    const key = fixtureKey("vendor/Weird Model:v2", "doc", 0);
    expect(key.split("__")[0]).toBe("vendor_Weird_Model_v2");
    expect(key).not.toContain("/");
    expect(key).not.toContain(" ");
    expect(key).not.toContain(":");
  });

  test("appends a 16-char hex hash segment", () => {
    expect(fixtureKey("m", "x", 0).split("__")[1]).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("fixturePath", () => {
  test("joins the key under FIXTURES_DIR with a .json extension", () => {
    const p = fixturePath("claude-opus-4-8", "doc", 0);
    expect(p.startsWith(FIXTURES_DIR)).toBe(true);
    expect(p.endsWith("claude-opus-4-8__af70cc638ec172b3.json")).toBe(true);
  });
});

describe("cachedExtract REPLAY_ONLY guard", () => {
  test("a cache miss throws instead of calling the live model when REPLAY_ONLY is set", async () => {
    // The throw must happen before extract() is reached, so this never spends.
    // The unique input + run index guarantees no fixture exists; the key is
    // also cleared as a backstop in case the guard ever regressed.
    const prevReplay = process.env.REPLAY_ONLY;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevRecord = process.env.RECORD;
    process.env.REPLAY_ONLY = "1";
    delete process.env.RECORD; // a stray RECORD=1 would bypass the guard; pin it off
    delete process.env.ANTHROPIC_API_KEY; // backstop: no spend even if the guard regressed
    let error: unknown;
    try {
      await cachedExtract("uncached REPLAY_ONLY probe input, no fixture exists", 424242);
    } catch (e) {
      error = e;
    } finally {
      if (prevReplay === undefined) delete process.env.REPLAY_ONLY;
      else process.env.REPLAY_ONLY = prevReplay;
      if (prevRecord !== undefined) process.env.RECORD = prevRecord;
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
    expect(String(error)).toMatch(/REPLAY_ONLY/);
  });
});

describe("cachedExtract replay", () => {
  // Exercise the CI-critical offline path against a real committed fixture: with
  // RECORD off and no key, a present fixture must replay -- never call the model.
  const fixtureFile = readdirSync(FIXTURES_DIR).find((f) => f.endsWith(".json"))!;
  const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, fixtureFile), "utf8"));

  test("a committed fixture replays offline and returns the recorded result verbatim", async () => {
    const prevRecord = process.env.RECORD;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.RECORD; // force the replay path, not a re-record
    delete process.env.ANTHROPIC_API_KEY; // backstop: no spend even on an unexpected miss
    try {
      const { result, source } = await cachedExtract(fx.input, fx.run_index);
      expect(source).toBe("replay");
      expect(result).toEqual(fx.result); // recorded result, not a live call
    } finally {
      if (prevRecord !== undefined) process.env.RECORD = prevRecord;
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
