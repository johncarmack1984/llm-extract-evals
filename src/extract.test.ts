import { describe, expect, test, mock, beforeEach } from "bun:test";

/**
 * Covers the retry/refusal/error control flow in extract() by mocking the
 * Anthropic client's messages.parse -- no network, no key, no spend. The mock
 * replaces only the SDK default export; the real zodOutputFormat helper still
 * runs, so the parse call is exercised exactly as in production.
 */
const parse = mock(async () => ({}) as any);
class MockAnthropic {
  messages = { parse };
}
mock.module("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));

// Belt-and-suspenders: the mock needs no key, but make a live call impossible.
delete process.env.ANTHROPIC_API_KEY;

const { extract } = await import("./extract");

const ok = (parsed: object) => ({ stop_reason: "end_turn", parsed_output: parsed, usage: { input_tokens: 10, output_tokens: 5 } });
const schemaMiss = { stop_reason: "end_turn", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } };

describe("extract", () => {
  beforeEach(() => parse.mockReset());

  test("a refusal is terminal: fails at attempt 1 without retrying", async () => {
    parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await extract("doc");
    expect(r).toMatchObject({ ok: false, error: "model refused the request", attempts: 1 });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  test("a thrown error fails fast at attempt 1 (does not re-issue the SDK's retries)", async () => {
    // This is the contract from the retry-multiplication fix: the SDK owns
    // transient retries, so a throw here is final -- the loop must not re-run it.
    parse.mockRejectedValue(new Error("kaboom"));
    const r = await extract("doc");
    expect(r).toMatchObject({ ok: false, error: "kaboom", attempts: 1 });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  test("a persistent schema miss retries to MAX_RETRIES+1 then fails", async () => {
    parse.mockResolvedValue(schemaMiss);
    const r = await extract("doc");
    expect(r).toMatchObject({ ok: false, error: "response did not satisfy the schema", attempts: 3 });
    expect(parse).toHaveBeenCalledTimes(3);
  });

  test("a schema miss followed by a valid parse succeeds on the later attempt", async () => {
    parse.mockResolvedValueOnce(schemaMiss).mockResolvedValueOnce(ok({ project_name: "Lone Star", capacity_mw: 250 }));
    const r = await extract("doc");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(2);
      expect(r.data.project_name).toBe("Lone Star");
    }
    expect(parse).toHaveBeenCalledTimes(2);
  });

  test("a valid parse returns the data plus recorded usage and latency", async () => {
    parse.mockResolvedValue(ok({ project_name: "Granite Peak", capacity_mw: 180 }));
    const r = await extract("doc");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(1);
      expect(r.data).toMatchObject({ project_name: "Granite Peak", capacity_mw: 180 });
      expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
      expect(Number.isFinite(r.latency_ms)).toBe(true); // present and a real number (timing itself isn't asserted under a mock)
    }
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
