import { describe, expect, test } from "bun:test";
import { parseCase, fieldStability } from "./eval";
import type { InterconnectionStudy } from "./schema";

const rec = (o: Record<string, unknown>) => o as unknown as InterconnectionStudy;

describe("parseCase", () => {
  test("parses a valid case and strips .json from the name", () => {
    const c = parseCase("01-lone-star.json", JSON.stringify({ input: "doc text", expected: { capacity_mw: 250 } }));
    expect(c).toEqual({ name: "01-lone-star", input: "doc text", expected: { capacity_mw: 250 } });
  });

  test("throws with the filename when the shape is malformed", () => {
    // a bad case file should fail loudly here, not crash deep in scoring
    expect(() => parseCase("bad.json", JSON.stringify({ expected: {} }))).toThrow(/bad\.json/);
    expect(() => parseCase("bad.json", JSON.stringify({ input: "d" }))).toThrow(/expected/);
    expect(() => parseCase("bad.json", JSON.stringify({ input: "d", expected: null }))).toThrow();
    expect(() => parseCase("bad.json", JSON.stringify({ input: "d", expected: [1] }))).toThrow();
    expect(() => parseCase("bad.json", JSON.stringify({ input: 5, expected: {} }))).toThrow();
  });
});

describe("fieldStability", () => {
  test("flags labeled fields that disagreed across runs", () => {
    const expected = { capacity_mw: 250, iso_rto: "ERCOT" as const };
    const records = [
      rec({ capacity_mw: 250, iso_rto: "ERCOT" }),
      rec({ capacity_mw: 300, iso_rto: "ERCOT" }),
      rec({ capacity_mw: 250, iso_rto: "PJM" }),
    ];
    const flaky = fieldStability(expected, records);
    expect(flaky.map((f) => f.field).sort()).toEqual(["capacity_mw", "iso_rto"]);
    expect(flaky[0]!.flakeRate).toBeCloseTo(1 / 3, 5); // 1 of 3 runs disagreed
  });

  test("returns nothing when every run agrees", () => {
    expect(fieldStability({ capacity_mw: 250 }, [rec({ capacity_mw: 250 }), rec({ capacity_mw: 250 })])).toEqual([]);
  });

  test("needs at least two non-null records to compare", () => {
    expect(fieldStability({ capacity_mw: 250 }, [rec({ capacity_mw: 250 }), null])).toEqual([]);
  });

  test("ignores fields absent from the gold label", () => {
    // capacity disagrees but isn't labeled, so it isn't reported
    const flaky = fieldStability({ iso_rto: "ERCOT" as const }, [
      rec({ capacity_mw: 250, iso_rto: "ERCOT" }),
      rec({ capacity_mw: 300, iso_rto: "ERCOT" }),
    ]);
    expect(flaky).toEqual([]);
  });
});
