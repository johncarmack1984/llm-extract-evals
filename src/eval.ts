import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "./extract";
import { FIELDS, type InterconnectionStudy } from "./schema";

type Case = { name: string; input: string; expected: Partial<InterconnectionStudy> };

const CASES_DIR = join(import.meta.dir, "..", "data", "cases");

function loadCases(): Case[] {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(CASES_DIR, f), "utf8"));
      return { name: f.replace(/\.json$/, ""), input: raw.input, expected: raw.expected };
    });
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  return String(v).trim().toLowerCase();
}

type Outcome = "correct" | "missing" | "wrong" | "hallucinated";

// missing      = a stated value the model left null
// wrong        = a stated value the model got wrong
// hallucinated = a value the model invented for a not-stated field
function classifyField(expected: unknown, got: unknown): Outcome {
  const e = norm(expected);
  const g = norm(got);
  if (e === "null") return g === "null" ? "correct" : "hallucinated";
  if (g === "null") return "missing";
  return e === g ? "correct" : "wrong";
}

const cases = loadCases();
const tally: Record<Outcome | "schema_invalid", number> = {
  correct: 0,
  missing: 0,
  wrong: 0,
  hallucinated: 0,
  schema_invalid: 0,
};
let schemaValid = 0;
let fieldsScored = 0;

for (const c of cases) {
  const result = await extract(c.input);

  if (!result.ok) {
    tally.schema_invalid++;
    console.log(`x  ${c.name}: ${result.error} (${result.attempts} attempts)`);
    continue;
  }
  schemaValid++;

  const off: string[] = [];
  for (const field of FIELDS) {
    if (!(field in c.expected)) continue; // only score labeled fields
    const want = (c.expected as Record<string, unknown>)[field];
    const got = (result.data as Record<string, unknown>)[field];
    const outcome = classifyField(want, got);
    tally[outcome]++;
    fieldsScored++;
    if (outcome !== "correct") {
      off.push(`${field}=${outcome} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    }
  }
  console.log(off.length === 0 ? `ok ${c.name}` : `~  ${c.name}: ${off.join("; ")}`);
}

const accuracy = fieldsScored ? (100 * tally.correct) / fieldsScored : 0;
console.log("\n=== eval summary ===");
console.log(`model:            ${process.env.MODEL ?? "claude-opus-4-8"}`);
console.log(`cases:            ${cases.length}`);
console.log(`schema-valid:     ${schemaValid}/${cases.length}`);
console.log(`field accuracy:   ${accuracy.toFixed(1)}%  (${tally.correct}/${fieldsScored})`);
console.log(
  `failure taxonomy: missing=${tally.missing} wrong=${tally.wrong} ` +
    `hallucinated=${tally.hallucinated} schema_invalid=${tally.schema_invalid}`,
);
