import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extract, MODEL } from "./extract";
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

const USAGE =
  "usage: bun run src/batch.ts <dir|file.jsonl> [--out f] [--concurrency 4] [--confidence 3] [--threshold 0.67] [--review f]";

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

export type BatchArgs = {
  path: string | undefined;
  out: string | undefined;
  review: string | undefined;
  concurrency: number;
  confidence: number;
  threshold: number;
};

/** A positive-integer option; falls back to `dflt` when absent or unparseable. */
function intOpt(raw: string | undefined, dflt: number): number {
  if (raw === undefined) return dflt;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(1, n) : dflt;
}

/** Confidence threshold clamped to [0,1]; falls back to 0.67 when absent or unparseable. */
function clampThreshold(raw: string | undefined): number {
  if (raw === undefined) return 0.67;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.67;
}

/**
 * Parse argv as `<path> [--flag value | --flag=value]...`. Every flag takes a
 * value, so we scan token by token rather than in fixed pairs -- a single
 * value-less flag (or a stray positional) is an explicit error instead of
 * silently shifting every following option onto the wrong flag. Throws on a
 * malformed argument; the caller turns that into a usage error.
 */
export function parseArgs(argv: string[]): BatchArgs {
  const [path, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    const m = /^--([^=]+)(?:=(.*))?$/.exec(tok);
    if (!m) throw new Error(`unexpected argument "${tok}" (expected a --flag)`);
    const key = m[1]!;
    let val = m[2];
    if (val === undefined) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`flag --${key} needs a value`);
      val = next;
      i++;
    }
    opts[key] = val;
  }
  return {
    path,
    out: opts.out,
    review: opts.review,
    concurrency: intOpt(opts.concurrency, 4),
    confidence: intOpt(opts.confidence, 1),
    threshold: clampThreshold(opts.threshold),
  };
}

/**
 * Parse JSONL text into items, skipping malformed lines instead of aborting the
 * whole run. Returns the parsed items plus the 1-based line numbers skipped, so
 * the caller can report them. Blank lines are ignored (not counted as skipped).
 *
 * A row without an `id` derives one from its line number (`line-<n>`) rather than
 * a running counter, so a derived id can't collide with an explicit sequential
 * id (`"1"`, `"2"`, ...) elsewhere in the file.
 */
export function parseJsonl(text: string): { items: Item[]; skipped: number[] } {
  const items: Item[] = [];
  const skipped: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      items.push({ id: String(row.id ?? `line-${i + 1}`), input: String(row.input ?? row.text ?? "") });
    } catch {
      skipped.push(i + 1);
    }
  }
  return { items, skipped };
}

function loadItems(path: string): Item[] {
  if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".md"))
      .sort()
      .map((f) => ({ id: f, input: readFileSync(join(path, f), "utf8") }));
  }
  // JSONL: one object per line, { id?, input | text }
  const { items, skipped } = parseJsonl(readFileSync(path, "utf8"));
  if (skipped.length) console.error(`skipped ${skipped.length} malformed JSONL line(s): ${skipped.join(", ")}`);
  return items;
}

/** Run `fn` over items with at most `limit` in flight; results stay in input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  // At least one worker whenever there's work: a caller-supplied limit of 0 must
  // not silently spawn zero workers and return an array of un-run holes.
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** Write a file, creating its parent directory first so a nested --out path doesn't ENOENT. */
function writeFileEnsuringDir(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * Extract one item into an output record. The try/catch keeps a single
 * unexpected throw from aborting the whole batch -- extract/extractWithConfidence
 * already return error results rather than throwing, so this is a guard, not the
 * normal path. `deps` is injectable so the record shaping can be unit-tested.
 */
export async function extractItem(
  item: Item,
  opts: { confidence: number; threshold: number },
  deps = { extract, extractWithConfidence },
): Promise<OutRecord> {
  try {
    if (opts.confidence > 1) {
      const c = await deps.extractWithConfidence(item.input, opts.confidence, opts.threshold);
      return c.ok
        ? { id: item.id, ok: true, model: MODEL, data: c.data, usage: c.usage, confidence: c.confidence, low_confidence: c.low_confidence }
        : { id: item.id, ok: false, model: MODEL, error: c.error };
    }
    const r = await deps.extract(item.input);
    return r.ok
      ? { id: item.id, ok: true, model: MODEL, data: r.data, usage: r.usage, latency_ms: r.latency_ms }
      : { id: item.id, ok: false, model: MODEL, error: r.error };
  } catch (e) {
    return { id: item.id, ok: false, model: MODEL, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  let args: BatchArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(USAGE);
    process.exit(1);
  }
  if (!args.path) {
    console.error(USAGE);
    process.exit(1);
  }

  let items: Item[];
  try {
    items = loadItems(args.path);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  console.error(`extracting ${items.length} document(s) with ${MODEL} (concurrency ${args.concurrency}` + (args.confidence > 1 ? `, confidence ${args.confidence} runs/doc` : "") + ")");

  const records = await mapPool(items, args.concurrency, (item) => extractItem(item, args));

  // Write results (JSONL).
  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (args.out) {
    writeFileEnsuringDir(args.out, jsonl);
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
      writeFileEnsuringDir(args.review, needsReview.map((r) => JSON.stringify(r)).join("\n") + "\n");
      console.error(`wrote review queue (${needsReview.length}) to ${args.review}`);
    }
  }
}

if (import.meta.main) {
  await main();
}
