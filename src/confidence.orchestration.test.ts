import { describe, expect, test, mock } from "bun:test";
import { extractWithConfidence } from "./confidence";
import type { InterconnectionStudy } from "./schema";
import type { ExtractResult } from "./extract";

/**
 * Covers extractWithConfidence's orchestration loop (usage-summing across runs,
 * ok_runs accounting, the all-fail short-circuit) by injecting a fake `extract`
 * -- no network, key, SDK mock, or spend. tallyConfidence (the pure vote) is
 * covered in confidence.test.ts. Injection (rather than mock.module) keeps this
 * from colliding with extract.test.ts's module mock.
 */
const rec = (o: Record<string, unknown>) => o as unknown as InterconnectionStudy;
const okResult = (data: InterconnectionStudy): ExtractResult => ({ ok: true, data, attempts: 1, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, latency_ms: 1 });
const failResult: ExtractResult = { ok: false, error: "schema miss", attempts: 3, model: "m" };

describe("extractWithConfidence orchestration", () => {
  test("sums usage across all successful runs and counts ok_runs", async () => {
    const extract = mock(async () => okResult(rec({ project_name: "X", capacity_mw: 250 })));
    const r = await extractWithConfidence("doc", 3, 0.67, { extract });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usage).toEqual({ input_tokens: 30, output_tokens: 15 }); // 3 x (10/5)
      expect(r.ok_runs).toBe(3);
      expect(r.runs).toBe(3);
    }
    expect(extract).toHaveBeenCalledTimes(3);
  });

  test("all runs failing returns ok:false with the run count and no usage", async () => {
    const extract = mock(async () => failResult);
    const r = await extractWithConfidence("doc", 2, 0.67, { extract });
    expect(r).toMatchObject({ ok: false, runs: 2 });
    expect(r).not.toHaveProperty("usage");
  });

  test("a partial failure tallies over only the successful runs", async () => {
    const extract = mock(async () => okResult(rec({ project_name: "X", capacity_mw: 250 })));
    extract
      .mockResolvedValueOnce(okResult(rec({ project_name: "X", capacity_mw: 250 })))
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(okResult(rec({ project_name: "X", capacity_mw: 250 })));
    const r = await extractWithConfidence("doc", 3, 0.67, { extract });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ok_runs).toBe(2); // 2 of 3 runs succeeded
      expect(r.runs).toBe(3);
      expect(r.usage).toEqual({ input_tokens: 20, output_tokens: 10 }); // summed over the 2 OK runs only
      expect(r.confidence.capacity_mw).toBe(1); // both samples agree
    }
  });
});
