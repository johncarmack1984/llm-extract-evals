import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extract, MODEL, type ExtractResult } from "./extract";
import { extractWithConfidence } from "./confidence";
import { costUsd, type Usage } from "./pricing";
import type { InterconnectionStudy } from "./schema";

/**
 * Batch extraction over a folder of documents or a JSONL file, with bounded
 * concurrency. Writes one JSON record per input to a JSONL output (or stdout),
 * and prints a run summary -- token/$ totals and the human-in-the-loop review
 * queue (records with low-confidence fields, when --confidence is on).
 *
 *   bun run batch <dir|file.jsonl> [--out results.jsonl] [--concurrency 4]
 *                                  [--confidence 3] [--threshold 0.67] [--review review.jsonl]
 *
 * Folder mode reads *.txt and *.md (id = filename). JSONL mode expects one
 * object per line with an `input` (or `text`) field and an optional `id`.
 */

type Item = { id: string; input: string };
type OutRecord = {
  id: string;
  ok: boolean;
  model: string;
  data?: InterconnectionStudy;
  error?: string;
  usage?: Usage;
  latency_ms?: number;
  confidence?: Record<string, number>;
  low_confidence?: string[];
};

function parseArgs(argv: string[]) {
  const [path, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (key && rest[i + 1] !== undefined) opts[key] = rest[i + 1]!;
  }
  return {
    path,
    out: opts.out,
    review: opts.review,
    concurrency: Math.max(1, parseInt(opts.concurrency ?? "4", 10) || 4),
    confidence: Math.max(1, parseInt(opts.confidence ?? "1", 10) || 1),
    threshold: parseFloat(opts.threshold ?? "0.67") || 0.67,
  };
}

function loadItems(path: string): Item[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".md"))
      .sort()
      .map((f) => ({ id: f, input: readFileSync(join(path, f), "utf8") }));
  }
  // JSONL: one object per line, { id?, input | text }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const row = JSON.parse(line);
      return { id: String(row.id ?? i + 1), input: String(row.input ?? row.text ?? "") };
    });
}

/** Run `fn` over items with at most `limit` in flight; results stay in input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const args = parseArgs(process.argv.slice(2));
if (!args.path) {
  console.error("usage: bun run src/batch.ts <dir|file.jsonl> [--out f] [--concurrency 4] [--confidence 3] [--threshold 0.67] [--review f]");
  process.exit(1);
}

const items = loadItems(args.path);
console.error(`extracting ${items.length} document(s) with ${MODEL} (concurrency ${args.concurrency}` + (args.confidence > 1 ? `, confidence ${args.confidence} runs/doc` : "") + ")");

const records = await mapPool(items, args.concurrency, async (item): Promise<OutRecord> => {
  if (args.confidence > 1) {
    const c = await extractWithConfidence(item.input, args.confidence, args.threshold);
    return c.ok
      ? { id: item.id, ok: true, model: MODEL, data: c.data, usage: c.usage, confidence: c.confidence, low_confidence: c.low_confidence }
      : { id: item.id, ok: false, model: MODEL, error: c.error };
  }
  const r: ExtractResult = await extract(item.input);
  return r.ok
    ? { id: item.id, ok: true, model: MODEL, data: r.data, usage: r.usage, latency_ms: r.latency_ms }
    : { id: item.id, ok: false, model: MODEL, error: r.error };
});

// Write results (JSONL).
const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
if (args.out) {
  writeFileSync(args.out, jsonl);
  console.error(`wrote ${records.length} records to ${args.out}`);
} else {
  process.stdout.write(jsonl);
}

// Summary: counts, cost, and the human-review queue.
const ok = records.filter((r) => r.ok);
const usage: Usage = ok.reduce(
  (a, r) => ({ input_tokens: a.input_tokens + (r.usage?.input_tokens ?? 0), output_tokens: a.output_tokens + (r.usage?.output_tokens ?? 0) }),
  { input_tokens: 0, output_tokens: 0 },
);
const cost = costUsd(MODEL, usage);
const needsReview = records.filter((r) => r.ok && r.low_confidence && r.low_confidence.length > 0);

console.error("\n=== batch summary ===");
console.error(`extracted:  ${ok.length}/${records.length} ok`);
console.error(`tokens:     ${usage.input_tokens} in / ${usage.output_tokens} out`);
console.error(`cost:       ${cost === null ? "unknown (no price listed for model)" : "$" + cost.toFixed(4)}`);
if (args.confidence > 1) {
  console.error(`review:     ${needsReview.length} record(s) have low-confidence fields`);
  for (const r of needsReview) console.error(`  ${r.id}: ${r.low_confidence!.join(", ")}`);
  if (args.review) {
    writeFileSync(args.review, needsReview.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.error(`wrote review queue (${needsReview.length}) to ${args.review}`);
  }
}
