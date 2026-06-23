import { describe, expect, test } from "bun:test";
import { fixtureKey, fixturePath, FIXTURES_DIR } from "./fixtures";

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
