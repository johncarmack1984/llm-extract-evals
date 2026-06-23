import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL } from "./extract";
import { cachedExtract } from "./fixtures";
import { FIELDS, type InterconnectionStudy } from "./schema";
import { accuracyOf, emptyTally, norm, scoreCase, type Tally } from "./score";
import { costUsd, type Usage } from "./pricing";

type Case = { name: string; input: string; expected: Partial<InterconnectionStudy> };

const CASES_DIR = join(import.meta.dir, "..", "data", "cases");
const RUNS = Math.max(1, parseInt(process.env.RUNS ?? "1", 10) || 1);

/**
 * Parse one case file's text into a Case, validating its shape (pure -- no I/O,
 * so it's unit-testable). A malformed file fails with the filename rather than
 * crashing the run with an opaque error deep in scoring.
 */
export function parseCase(file: string, text: string): Case {
  const raw = JSON.parse(text);
  if (typeof raw.input !== "string" || typeof raw.expected !== "object" || raw.expected === null || Array.isArray(raw.expected)) {
    throw new Error(`case ${file}: expected an object { input: string, expected: object }`);
  }
  return { name: file.replace(/\.json$/, ""), input: raw.input, expected: raw.expected };
}

export function loadCases(): Case[] {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => parseCase(f, readFileSync(join(CASES_DIR, f), "utf8")));
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** For one case run RUNS times, the labeled fields whose value wasn't unanimous, worst-flake first. */
export function fieldStability(expected: Partial<InterconnectionStudy>, records: (InterconnectionStudy | null)[]) {
  const present = records.filter((r): r is InterconnectionStudy => r !== null);
  const out: { field: string; flakeRate: number }[] = [];
  if (present.length < 2) return out;
  for (const field of FIELDS) {
    if (!(field in expected)) continue;
    const vals = present.map((r) => norm((r as Record<string, unknown>)[field]));
    const counts = new Map<string, number>();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    const modal = Math.max(...counts.values());
    const flakeRate = (vals.length - modal) / vals.length;
    if (flakeRate > 0) out.push({ field, flakeRate });
  }
  return out.sort((a, b) => b.flakeRate - a.flakeRate);
}

async function main() {
  const cases = loadCases();

  const totalTally = emptyTally();
  const fieldTally: Record<string, Tally> = {};
  const usageTotal: Usage = { input_tokens: 0, output_tokens: 0 };
  const latencies: number[] = [];
  const perRunAccuracy: number[] = [];
  let okRuns = 0;
  let totalRuns = 0;
  let schemaInvalid = 0;
  let sawReplay = false;
  let sawLive = false; // a genuine unrecorded live call (distinct from RECORD's "recorded")

  for (const c of cases) {
    const records: (InterconnectionStudy | null)[] = [];

    for (let r = 0; r < RUNS; r++) {
      const { result, source } = await cachedExtract(c.input, r);
      totalRuns++;
      sawReplay ||= source === "replay";
      sawLive ||= source === "live";

      if (!result.ok) {
        schemaInvalid++;
        records.push(null);
        if (RUNS === 1) console.log(`x  ${c.name}: ${result.error} (${result.attempts} attempts)`);
        continue;
      }

      okRuns++;
      usageTotal.input_tokens += result.usage.input_tokens;
      usageTotal.output_tokens += result.usage.output_tokens;
      latencies.push(result.latency_ms);
      records.push(result.data);

      const runTally = emptyTally();
      for (const { field, outcome } of scoreCase(c.expected, result.data)) {
        totalTally[outcome]++;
        (fieldTally[field] ??= emptyTally())[outcome]++;
        runTally[outcome]++;
      }
      perRunAccuracy.push(accuracyOf(runTally));
    }

    if (RUNS === 1) {
      const rec = records[0];
      if (!rec) continue; // already logged the x line
      const off = scoreCase(c.expected, rec)
        .filter((x) => x.outcome !== "correct")
        .map((x) => `${x.field}=${x.outcome} (got ${JSON.stringify(x.got)}, want ${JSON.stringify(x.want)})`);
      console.log(off.length === 0 ? `ok ${c.name}` : `~  ${c.name}: ${off.join("; ")}`);
    } else {
      const flaky = fieldStability(c.expected, records);
      const note = flaky.length
        ? flaky.map((f) => `${f.field} ${(f.flakeRate * 100).toFixed(0)}%`).join(", ")
        : "stable";
      console.log(`~  ${c.name}: ${note}`);
    }
  }

  const scored = totalTally.correct + totalTally.missing + totalTally.wrong + totalTally.hallucinated;
  const accuracy = accuracyOf(totalTally);

  if (sawReplay && !sawLive) {
    console.log("\n(replaying fixtures -- offline, no API calls; usage/latency are recorded values)");
  } else if (sawReplay && sawLive) {
    console.log("\n(mixed -- some cases replayed from fixtures, some called live)");
  }

  console.log("\n=== eval summary ===");
  console.log(`model:            ${MODEL}`);
  console.log(`cases:            ${cases.length}${RUNS > 1 ? ` x ${RUNS} runs` : ""}`);
  console.log(`schema-valid:     ${okRuns}/${totalRuns}`);
  console.log(`field accuracy:   ${accuracy.toFixed(1)}%  (${totalTally.correct}/${scored})`);
  if (RUNS > 1 && perRunAccuracy.length) {
    console.log(
      `  per-run spread: mean ${avg(perRunAccuracy).toFixed(1)}%  ` +
        `min ${Math.min(...perRunAccuracy).toFixed(1)}%  max ${Math.max(...perRunAccuracy).toFixed(1)}%`,
    );
  }
  console.log(
    `failure taxonomy: missing=${totalTally.missing} wrong=${totalTally.wrong} ` +
      `hallucinated=${totalTally.hallucinated} schema_invalid=${schemaInvalid}`,
  );

  console.log("\nper-field accuracy (worst first):");
  const rows = Object.entries(fieldTally)
    .map(([field, t]) => ({ field, acc: accuracyOf(t), t }))
    .sort((a, b) => a.acc - b.acc);
  for (const { field, acc, t } of rows) {
    const issues = (["missing", "wrong", "hallucinated"] as const)
      .filter((k) => t[k] > 0)
      .map((k) => `${k}=${t[k]}`);
    console.log(`  ${field.padEnd(26)}${acc.toFixed(0).padStart(4)}%${issues.length ? `  (${issues.join(" ")})` : ""}`);
  }

  const cost = costUsd(MODEL, usageTotal);
  console.log("\ncost + latency:");
  console.log(`  tokens:         ${usageTotal.input_tokens} in / ${usageTotal.output_tokens} out`);
  console.log(
    `  cost:           ${cost === null ? "unknown (no price listed for model)" : "$" + cost.toFixed(4)}` +
      ` over ${okRuns} extraction${okRuns === 1 ? "" : "s"}`,
  );
  if (latencies.length) {
    console.log(`  latency:        mean ${Math.round(avg(latencies))}ms, max ${Math.max(...latencies)}ms`);
  }
}

if (import.meta.main) {
  await main();
}
