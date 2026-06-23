import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL } from "../src/extract";
import { FIXTURES_DIR, fixturePath, type Fixture } from "../src/fixtures";
import type { ExtractResult } from "../src/extract";

/**
 * Generate ILLUSTRATIVE fixtures so `bun run eval` works offline, with no API
 * key or spend. These are synthetic model outputs derived from the gold labels
 * -- NOT real API recordings. To capture real responses from the live model
 * instead, run `RECORD=1 bun run eval` (overwrites these). See
 * data/fixtures/README.md.
 *
 * The output equals the gold label for every case except those in OVERRIDES,
 * which are hand-authored to demonstrate each failure-taxonomy outcome on the
 * trap it pairs with -- so the offline run exercises all four outcomes, not just
 * "correct". These are illustrations of the trap, not measured model behavior:
 *   02 (inference bait)      status active vs null    -> hallucinated
 *   06 (superseded $ figure) picks the old $5M cost   -> wrong
 *   08 (inference bait)      infers active in-queue    -> hallucinated
 *   09 (65% allocation trap) leaves a stated cost null -> missing
 */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  "02-prairie-wind": { status: "active" },
  "06-cedar-ridge-wind": { network_upgrade_cost_usd: 5000000 },
  "08-tumbleweed-storage": { status: "active" },
  "09-blue-mesa-hybrid": { network_upgrade_cost_usd: null },
};

const CASES_DIR = join(import.meta.dir, "..", "data", "cases");
const tokens = (s: string) => Math.max(1, Math.round(s.length / 4));

mkdirSync(FIXTURES_DIR, { recursive: true });

let written = 0;
for (const file of readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const name = file.replace(/\.json$/, "");
  const raw = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
  const input: string = raw.input;

  const data = { ...raw.expected, ...(OVERRIDES[name] ?? {}) };
  const result: ExtractResult = {
    ok: true,
    data,
    attempts: 1,
    model: MODEL,
    usage: { input_tokens: tokens(input) + 115, output_tokens: tokens(JSON.stringify(data)) },
    latency_ms: 1800 + (input.length % 700), // deterministic, plausible
  };

  const fx: Fixture = { model: MODEL, run_index: 0, input, result };
  writeFileSync(fixturePath(MODEL, input, 0), JSON.stringify(fx, null, 2) + "\n");
  written++;
}

console.log(`wrote ${written} illustrative fixtures for ${MODEL} to data/fixtures/`);
