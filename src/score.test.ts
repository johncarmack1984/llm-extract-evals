import { describe, expect, test } from "bun:test";
import { accuracyOf, classifyField, emptyTally, norm, scoreCase } from "./score";

describe("norm", () => {
  test("null and undefined both collapse to 'null'", () => {
    expect(norm(null)).toBe("null");
    expect(norm(undefined)).toBe("null");
  });

  test("numbers stringify exactly (no locale separators)", () => {
    expect(norm(250)).toBe("250");
    expect(norm(42700000)).toBe("42700000");
    expect(norm(0)).toBe("0");
  });

  test("strings are trimmed and lowercased", () => {
    expect(norm("  ERCOT ")).toBe("ercot");
    expect(norm("Big Spring 345 kV Substation")).toBe("big spring 345 kv substation");
  });

  test("the string '250' and the number 250 compare equal", () => {
    expect(norm("250")).toBe(norm(250));
  });

  test("negative and fractional numbers stringify exactly", () => {
    expect(norm(-5)).toBe("-5");
    expect(norm(42.7)).toBe("42.7");
    expect(norm(-0)).toBe("0"); // -0 and 0 collapse to the same key
  });

  test("floating-point drift collapses to a stable key", () => {
    // 0.1 + 0.2 is 0.30000000000000004; it must not read as a different value than 0.3
    expect(norm(0.1 + 0.2)).toBe("0.3");
    expect(norm(0.1 + 0.2)).toBe(norm(0.3));
  });

  test("a real 0 stays distinct from null (0 is a stated value, not 'missing')", () => {
    // load-bearing for classifyField: a stated 0 must not read as 'not stated'
    expect(norm(0)).not.toBe(norm(null));
  });

  test("NaN normalizes to 'NaN' and is not confused with null", () => {
    expect(norm(NaN)).toBe("NaN");
    expect(norm(NaN)).not.toBe(norm(null));
  });
});

describe("classifyField", () => {
  test("correct: matching stated values, case/whitespace-insensitive", () => {
    expect(classifyField("ERCOT", "ercot")).toBe("correct");
    expect(classifyField(250, 250)).toBe("correct");
  });

  test("correct: both null (rewarding a correctly-blank field)", () => {
    expect(classifyField(null, null)).toBe("correct");
  });

  test("missing: a stated value the model left null", () => {
    expect(classifyField("MISO", null)).toBe("missing");
    expect(classifyField(180, null)).toBe("missing");
  });

  test("wrong: a stated value extracted incorrectly", () => {
    expect(classifyField(250, 251)).toBe("wrong");
    expect(classifyField("solar", "wind")).toBe("wrong");
  });

  test("hallucinated: a value invented for a not-stated field", () => {
    expect(classifyField(null, "active")).toBe("hallucinated");
    expect(classifyField(null, 0)).toBe("hallucinated");
  });

  test("the documented case-02 disagreement is a hallucination, not a 'wrong'", () => {
    // gold leaves status null (not stated); model infers "active"
    expect(classifyField(null, "active")).toBe("hallucinated");
  });
});

describe("scoreCase", () => {
  test("scores only labeled fields; unlabeled fields are skipped", () => {
    const expected = { project_name: "Lone Star", iso_rto: "ERCOT" as const };
    const got = { project_name: "Lone Star", iso_rto: "ERCOT" as const, capacity_mw: 999 };
    const results = scoreCase(expected, got);
    expect(results.map((r) => r.field).sort()).toEqual(["iso_rto", "project_name"]);
    expect(results.every((r) => r.outcome === "correct")).toBe(true);
  });

  test("a null label with a non-null extraction is hallucinated", () => {
    const results = scoreCase({ status: null }, { status: "active" as const });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("hallucinated");
  });

  test("carries got/want through for reporting", () => {
    const [r] = scoreCase({ capacity_mw: 250 }, { capacity_mw: 251 });
    expect(r).toMatchObject({ field: "capacity_mw", outcome: "wrong", got: 251, want: 250 });
  });
});

describe("accuracyOf", () => {
  test("empty tally is 0%, not NaN", () => {
    expect(accuracyOf(emptyTally())).toBe(0);
  });

  test("59 correct of 60 is the documented 98.3%", () => {
    const t = emptyTally();
    t.correct = 59;
    t.hallucinated = 1;
    expect(accuracyOf(t)).toBeCloseTo(98.333, 2);
  });

  test("all four outcomes count toward the denominator", () => {
    // 1 correct of 4 scored -> 25%; guards against missing/wrong being dropped from the total
    const t = emptyTally();
    t.correct = 1;
    t.missing = 1;
    t.wrong = 1;
    t.hallucinated = 1;
    expect(accuracyOf(t)).toBe(25);
  });
});
