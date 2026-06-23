# llm-extract-evals

Schema-validated extraction of structured data from grid interconnection documents, with an eval harness around it. A focused demonstration of the parts of production LLM work that matter: **structured outputs, retries, evals with a failure taxonomy, deterministic offline replay, cost/latency accounting, and confidence-gated human review** -- not a one-off "call the API and hope" script.

Built with the Anthropic SDK (Claude). Energy/grid is the worked example; the technique is domain-agnostic.

## What it does

1. **Extract** (`src/extract.ts`) -- takes a free-text interconnection study or queue entry and returns a typed record (project, capacity, ISO/RTO, queue id, study phase, status, upgrade cost, ...). The response is constrained to a schema (`src/schema.ts`) via structured outputs, so the output is valid by construction; malformed responses are retried, a model refusal is treated as terminal, and each success carries its token usage and latency.
2. **Eval** (`src/eval.ts`) -- runs extraction over a set of gold-labeled cases (`data/cases/`) and scores it: field-level accuracy, schema-valid rate, a per-field breakdown, a failure taxonomy, and token/cost/latency totals. Runs **deterministically offline** by replaying recorded fixtures (no key, no spend), with an optional `RUNS=N` mode that measures run-to-run variance.
3. **Batch** (`src/batch.ts`) -- extracts over a folder of documents or a JSONL file with bounded concurrency, emits one JSON record per input, and (with `--confidence`) routes low-confidence fields to a human-review queue.

The design choice that matters: a field is `null` only when the document does not state it. The eval rewards leaving unknowns blank and penalizes invention -- the failure mode that makes naive extraction unsafe to ship.

## Failure taxonomy

The scorer classifies every labeled field into one of four outcomes, because "accuracy" alone hides the failure that actually hurts (a confidently wrong or invented value):

| Outcome        | Meaning                                            |
| -------------- | -------------------------------------------------- |
| `correct`      | Matches the gold label (including correct `null`). |
| `missing`      | A stated value the model left `null`.              |
| `wrong`        | A stated value the model extracted incorrectly.    |
| `hallucinated` | A value the model invented for a not-stated field. |

`schema_invalid` is tracked separately: a case whose response never satisfied the schema after retries. The pure scoring logic lives in `src/score.ts` and is unit-tested directly (`src/score.test.ts`) -- the eval methodology is itself covered by tests.

## Example run

```
ok 01-lone-star-solar
~  02-prairie-wind: status=hallucinated (got "active", want null)
ok 03-mojave-storage
ok 04-keystone-peaker
ok 05-desert-bloom
~  06-cedar-ridge-wind: network_upgrade_cost_usd=wrong (got 5000000, want 7200000)
ok 07-saguaro-solar
~  08-tumbleweed-storage: status=hallucinated (got "active", want null)
~  09-blue-mesa-hybrid: network_upgrade_cost_usd=missing (got null, want 128500000)

(replaying fixtures -- offline, no API calls; usage/latency are recorded values)

=== eval summary ===
model:            claude-opus-4-8
cases:            9
schema-valid:     9/9
field accuracy:   96.3%  (104/108)
failure taxonomy: missing=1 wrong=1 hallucinated=2 schema_invalid=0

per-field accuracy (worst first):
  status                      78%  (hallucinated=2)
  network_upgrade_cost_usd    78%  (missing=1 wrong=1)
  project_name               100%
  ... (remaining fields 100%)

cost + latency:
  tokens:         1723 in / 690 out
  cost:           $0.0259 over 9 extractions
  latency:        mean 2105ms, max 2172ms
```

The per-field breakdown is the useful view: it pins the weakness to two fields -- `status` (over-inferred from queue narrative) and `network_upgrade_cost_usd` (confused by superseded figures and cost-allocation percentages) -- rather than reporting a single opaque accuracy number.

> **The committed fixtures are illustrative.** The four surfaced failures are hand-authored to exercise each taxonomy outcome on the trap it pairs with (see `data/fixtures/README.md`); the `96.3%` is therefore a property of the demo fixtures, not a measured model score. Run `RECORD=1 bun run eval` to score the real model.

## Deterministic, offline, and tested

The eval is non-deterministic and costs money if it calls the model every run -- so it can't gate CI and its numbers aren't reproducible. This repo fixes that with a **record/replay fixture layer** (`src/fixtures.ts`):

- By default, `bun run eval` replays committed fixtures keyed by `(model, run-index, input)` -- no API key, no network, no spend, identical numbers every time.
- `RECORD=1 bun run eval` calls the live model and overwrites the fixtures for the current `MODEL`, capturing real responses (including usage and latency).
- `REPLAY_ONLY=1 bun run eval` turns a missing fixture into a hard error instead of a silent fall-through to a billed live call -- a guard for runs (and CI) you intend to keep offline and free.
- CI (`.github/workflows/ci.yml`) runs typecheck + unit tests + the replayed eval on every push, with no secret required.

## The harder cases

`data/cases/06`-`09` are adversarial on purpose -- the hard judgment lives in the gold labels:

- **06** -- a current cost estimate alongside a *superseded* earlier figure, and a distractor count ("three contingency scenarios"); the label takes the current cost.
- **07** -- a cluster study describing **two** projects with a shared interconnection point; the label extracts the named subject and ignores the neighbor's capacity.
- **08** -- inference bait: an agreement "not yet executed" and a study "in progress" tempt a `status: active`, but the label leaves `status` null because no explicit status is stated.
- **09** -- a total upgrade cost paired with a "65% cost allocation" percentage and a quarter-granularity date; the label takes the full cost and leaves `in_service_date` null.

## Run it

Requires [Bun](https://bun.sh).

```sh
bun install
bun run eval                 # score the gold cases -- replays fixtures, no key needed
bun test                     # unit tests for the scorer and confidence voting
bun run typecheck            # tsc --noEmit
```

Anything that calls the live model needs a key:

```sh
cp .env.example .env         # then put your Anthropic API key in .env
bun run extract data/samples/willow-creek.txt   # extract a single document
bun run batch data/samples --out results.jsonl  # extract a folder -> JSONL
RUNS=5 bun run eval          # variance sweep: 5 runs/case (run 0 replays, rest live), per-field flake
```

`.env` is gitignored -- never commit a key.

### Variance

`RUNS=N bun run eval` extracts each case N times (live) and reports the per-run accuracy spread plus, per case, which fields disagreed across runs. Single-run accuracy on a stochastic model hides this; the variance mode surfaces fields that are unstable even when they're often right.

### Confidence and human-in-the-loop review

`src/confidence.ts` implements **self-consistency**: extract a document N times and take a per-field majority vote. A field's confidence is the fraction of runs that agreed on the modal value; fields below a threshold are flagged for human review -- the low-confidence queue a real pipeline routes to a person instead of trusting blindly. Because structured outputs make every run schema-valid, disagreement is genuine model uncertainty about *what* the value is.

```sh
bun run batch data/samples --confidence 3 --threshold 0.67 --review review.jsonl
```

This extracts each document 3 times, writes consensus records to stdout (or `--out`), and writes only the records with low-confidence fields to `review.jsonl`. Cost scales ~linearly with the run count, so it's opt-in.

## Credentials -- bring your own

The tool ships no key of its own. It calls the Anthropic Messages API through the official SDK, which authenticates with an `ANTHROPIC_API_KEY` and bills that key's account on pay-as-you-go API credits -- so anyone who runs it pays for their own usage, and the author's account is never involved. Note this is API billing, not a Claude.ai (Pro/Max) subscription.

Put your key in `.env` as `ANTHROPIC_API_KEY` (get one at console.anthropic.com). Only the live paths need it -- `extract`, `batch`, and the `RECORD=1` / `RUNS>1` eval; replaying the committed fixtures needs no credentials at all.

## Model and cost

The extraction model is the `MODEL` env var (default `claude-opus-4-8`). For fast, cheap eval sweeps while iterating on the schema or prompt, switch to a lighter tier and record its own fixtures:

```sh
MODEL=claude-haiku-4-5 RECORD=1 bun run eval   # record real Haiku responses
MODEL=claude-haiku-4-5 bun run eval            # then replay them offline
```

Fixtures are keyed by model, so each model keeps its own set. The eval and batch summaries price token usage from `src/pricing.ts` (per-model rates, current as of 2026-06); an unknown model reports `unknown` rather than guessing. Output is a small JSON record per document, so token cost is dominated by the input; structured outputs add a one-time schema-compilation cost cached for subsequent calls.

## Scope and honesty

This is a portfolio demonstration. The cases in `data/cases/` are synthetic but realistic (no proprietary or scraped data), and the committed fixtures in `data/fixtures/` are illustrative stand-ins, not live recordings (see that directory's README). The point is the technique: schema-constrained extraction, retry/validation, an eval methodology with a failure taxonomy, deterministic replay, cost accounting, and confidence-gated review. A production deployment would add a larger human-labeled set, prompt iteration measured against it, and persistence/observability around the batch path.

## Layout

```
src/schema.ts       the extraction target (Zod) + ordered field list
src/extract.ts      one-document extraction: structured output, retry, refusal handling, usage + latency
src/score.ts        pure scoring: classify each field, aggregate the taxonomy (unit-tested)
src/score.test.ts   unit tests for the scorer
src/pricing.ts      per-model token pricing -> USD cost
src/fixtures.ts     record/replay cache so the eval runs deterministically offline
src/eval.ts         run the gold set: accuracy, per-field, taxonomy, cost/latency, variance
src/confidence.ts   self-consistency vote -> per-field confidence + review queue (unit-tested)
src/confidence.test.ts  unit tests for the confidence vote
src/batch.ts        extract a folder/JSONL with concurrency; emit JSONL + review queue
src/run.ts          extract a single file from the CLI
data/cases/         gold-labeled examples ({ input, expected })
data/fixtures/      recorded responses for offline replay (illustrative)
data/samples/       sample documents for the batch/extract commands
scripts/            generator for the illustrative fixtures
.github/workflows/  CI: typecheck + tests + replayed eval
```
