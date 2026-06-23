import { extract } from "./extract";
import { FIELDS, type InterconnectionStudy } from "./schema";
import { norm } from "./score";
import type { Usage } from "./pricing";

/**
 * Confidence via self-consistency: extract the same document `runs` times and
 * take a per-field majority vote. A field's confidence is the fraction of
 * successful runs that agreed on the modal value; structured outputs make every
 * run schema-valid, so disagreement is genuine model uncertainty about *what*
 * the value is. Fields below `threshold` are flagged for human review -- the
 * low-confidence queue a real pipeline routes to a person instead of trusting.
 *
 * Costs ~`runs`x a single extraction, so this is opt-in (the eval and the
 * default batch path use a single deterministic call).
 */
export type ConfidenceResult =
  | {
      ok: true;
      data: InterconnectionStudy; // consensus: modal value per field
      confidence: Record<string, number>; // per-field agreement in [0,1]
      low_confidence: string[]; // fields below the threshold
      runs: number;
      ok_runs: number;
      usage: Usage; // summed across runs
    }
  | { ok: false; error: string; runs: number };

export async function extractWithConfidence(
  text: string,
  runs = 3,
  threshold = 0.67,
): Promise<ConfidenceResult> {
  const samples: InterconnectionStudy[] = [];
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let lastError = "no successful extraction";

  for (let i = 0; i < runs; i++) {
    const r = await extract(text);
    if (r.ok) {
      samples.push(r.data);
      usage.input_tokens += r.usage.input_tokens;
      usage.output_tokens += r.usage.output_tokens;
    } else {
      lastError = r.error;
    }
  }

  if (samples.length === 0) return { ok: false, error: lastError, runs };

  const { data, confidence, low_confidence } = tallyConfidence(samples, threshold);
  return { ok: true, data, confidence, low_confidence, runs, ok_runs: samples.length, usage };
}

/**
 * Per-field majority vote over a set of extracted records (pure -- no I/O, so
 * it's unit-testable). Returns the modal value per field, the agreement
 * fraction, and the fields whose agreement fell below `threshold`. On a tie
 * between a stated value and "not stated", the consensus is null -- the safe
 * default when the output feeds a human-review queue.
 */
export function tallyConfidence(
  samples: InterconnectionStudy[],
  threshold = 0.67,
): { data: InterconnectionStudy; confidence: Record<string, number>; low_confidence: string[] } {
  const data = {} as Record<string, unknown>;
  const confidence: Record<string, number> = {};
  const low: string[] = [];

  for (const field of FIELDS) {
    // Tally normalized values, keeping one representative raw value per group.
    const groups = new Map<string, { n: number; raw: unknown }>();
    for (const s of samples) {
      const raw = (s as Record<string, unknown>)[field];
      const g = groups.get(norm(raw));
      if (g) g.n++;
      else groups.set(norm(raw), { n: 1, raw });
    }
    let best = { n: 0, raw: null as unknown };
    for (const g of groups.values()) if (g.n > best.n) best = g; // first-seen wins value-vs-value ties

    // Safety bias: if "not stated" (null) tied the modal count, take it over a
    // stated value. The unsafe error for a review pipeline is trusting an
    // invented value, so a value-vs-null deadlock defaults to null rather than
    // to whichever run happened to come first -- and a null consensus is the
    // literal null the schema expects, not an absent field's undefined.
    const notStated = groups.get("null");
    if (notStated && notStated.n === best.n && best.raw !== null) best = { n: notStated.n, raw: null };

    data[field] = best.raw;
    confidence[field] = best.n / samples.length;
    if (confidence[field]! < threshold) low.push(field);
  }

  return { data: data as InterconnectionStudy, confidence, low_confidence: low };
}
