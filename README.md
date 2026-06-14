# llm-extract-evals

Schema-validated extraction of structured data from grid interconnection
documents, with an eval harness around it. A focused demonstration of the parts
of production LLM work that matter: **structured outputs, retries, and evals with
a failure taxonomy** -- not a one-off "call the API and hope" script.

Built with the Anthropic SDK (Claude). Energy/grid is the worked example; the
technique is domain-agnostic.

## What it does

1. **Extract** (`src/extract.ts`) -- takes a free-text interconnection study or
   queue entry and returns a typed record (project, capacity, ISO/RTO, queue id,
   study phase, status, upgrade cost, ...). The response is constrained to a
   schema (`src/schema.ts`) via structured outputs, so the output is valid by
   construction; malformed responses are retried, and a model refusal is treated
   as terminal.
2. **Eval** (`src/eval.ts`) -- runs extraction over a set of gold-labeled cases
   (`data/cases/`) and scores it: field-level accuracy, schema-valid rate, and a
   failure taxonomy that separates the ways extraction can go wrong.

The design choice that matters: a field is `null` only when the document does
not state it. The eval rewards leaving unknowns blank and penalizes invention --
the failure mode that makes naive extraction unsafe to ship.

## Failure taxonomy

The scorer classifies every labeled field into one of four outcomes, because
"accuracy" alone hides the failure that actually hurts (a confidently wrong or
invented value):

| Outcome        | Meaning                                            |
| -------------- | -------------------------------------------------- |
| `correct`      | Matches the gold label (including correct `null`). |
| `missing`      | A stated value the model left `null`.              |
| `wrong`        | A stated value the model extracted incorrectly.    |
| `hallucinated` | A value the model invented for a not-stated field. |

`schema_invalid` is tracked separately: a case whose response never satisfied the
schema after retries.

## Example run

```
ok 01-lone-star-solar
~  02-prairie-wind: status=hallucinated (got "active", want null)
ok 03-mojave-storage
ok 04-keystone-peaker
ok 05-desert-bloom

=== eval summary ===
model:            claude-opus-4-8
cases:            5
schema-valid:     5/5
field accuracy:   98.3%  (59/60)
failure taxonomy: missing=0 wrong=0 hallucinated=1 schema_invalid=0
```

The one surfaced failure is the interesting case: case 02 states only that "a
feasibility study is underway," with no explicit queue status. The model
inferred `status: "active"`; the gold label treats status as not-stated
(`null`). That disagreement is the point -- it forces the labeling policy to be
explicit (strict extraction vs. reasonable inference), the same judgment a real
extraction pipeline has to make and an eval has to encode.

## Run it

Requires [Bun](https://bun.sh).

```sh
bun install
cp .env.example .env      # then put your Anthropic API key in .env
bun run eval              # score the gold cases
bun run extract data/some-doc.txt   # extract a single document
```

`.env` is gitignored -- never commit a key.

## Credentials -- bring your own

The tool ships no key of its own. It runs on whatever Anthropic account you
authenticate with and spends that account's credits, so anyone who runs it pays
for their own usage -- the author's account is never involved.

- **API key (default):** put your key in `.env` as `ANTHROPIC_API_KEY`
  (get one at console.anthropic.com).
- **Log in with your Claude account (keyless):** authenticate with the Anthropic
  CLI, hand the session to the run, and remove `ANTHROPIC_API_KEY` from `.env`
  so your login is used:

  ```sh
  ant auth login
  set -a; eval "$(ant auth print-credentials --env)"; set +a
  bun run eval
  ```

The Messages API this calls runs on pay-as-you-go API credits, not a Claude.ai
(Pro/Max) subscription -- whichever account you authenticate with needs API
credits.

## Model and cost

The extraction model is the `MODEL` env var (default `claude-opus-4-8`). For
fast, cheap eval sweeps while iterating on the schema or prompt, switch to a
lighter tier:

```sh
MODEL=claude-haiku-4-5 bun run eval
```

Output is a small JSON record per document, so token cost is dominated by the
input; structured outputs add a one-time schema-compilation cost cached for
subsequent calls.

## Scope and honesty

This is a portfolio demonstration. The cases in `data/cases/` are synthetic but
realistic (no proprietary or scraped data), and the point is the technique:
schema-constrained extraction, retry/validation, and an eval methodology with a
failure taxonomy. It is a foundation to build a real pipeline on -- batching,
human-in-the-loop review of low-confidence fields, and a larger labeled set --
not a claim of production scale.

## Layout

```
src/schema.ts   the extraction target (Zod) + field list
src/extract.ts  one-document extraction: structured output, retry, refusal handling
src/eval.ts     run the gold set, score accuracy + failure taxonomy
src/run.ts      extract a single file from the CLI
data/cases/     gold-labeled examples ({ input, expected })
```
