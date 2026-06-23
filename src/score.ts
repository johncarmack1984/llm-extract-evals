import { FIELDS, type InterconnectionStudy } from "./schema";

/**
 * Pure scoring logic for the eval -- no I/O, no API calls, no side effects, so
 * it can be unit-tested directly (see score.test.ts). The eval harness
 * (eval.ts) wraps this with case loading, the model call, and reporting.
 */

export type Outcome = "correct" | "missing" | "wrong" | "hallucinated";
export type Tally = Record<Outcome, number>;

/**
 * Normalize a value for comparison: null/undefined -> "null", numbers
 * stringified exactly, strings trimmed and lowercased. This is what makes
 * `"ERCOT"` match `"ercot"` and `250` match `250` while keeping `null`
 * distinct from any stated value.
 */
export function norm(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  return String(v).trim().toLowerCase();
}

/**
 * Classify one field against its gold label.
 *   correct      = matches the label (including a correctly-left-null field)
 *   missing      = a stated value the model left null
 *   wrong        = a stated value the model extracted incorrectly
 *   hallucinated = a value the model invented for a not-stated (null) field
 */
export function classifyField(expected: unknown, got: unknown): Outcome {
  const e = norm(expected);
  const g = norm(got);
  if (e === "null") return g === "null" ? "correct" : "hallucinated";
  if (g === "null") return "missing";
  return e === g ? "correct" : "wrong";
}

export type FieldResult = {
  field: keyof InterconnectionStudy;
  outcome: Outcome;
  got: unknown;
  want: unknown;
};

/**
 * Score one extracted record against the (partial) gold label, over labeled
 * fields only -- a field absent from `expected` is not scored.
 */
export function scoreCase(
  expected: Partial<InterconnectionStudy>,
  got: Partial<InterconnectionStudy>,
): FieldResult[] {
  const results: FieldResult[] = [];
  for (const field of FIELDS) {
    if (!(field in expected)) continue;
    const want = (expected as Record<string, unknown>)[field];
    const g = (got as Record<string, unknown>)[field];
    results.push({ field, outcome: classifyField(want, g), got: g, want });
  }
  return results;
}

export function emptyTally(): Tally {
  return { correct: 0, missing: 0, wrong: 0, hallucinated: 0 };
}

/** Field accuracy (% correct) for a tally; 0 when nothing was scored. */
export function accuracyOf(tally: Tally): number {
  const total = tally.correct + tally.missing + tally.wrong + tally.hallucinated;
  return total ? (100 * tally.correct) / total : 0;
}
