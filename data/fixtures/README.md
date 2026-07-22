# Fixtures (record / replay)

These JSON files are recorded model responses, keyed by a content hash of `(model, run-index, input)`. They let `bun run eval` run **deterministically, offline, with no API key and no spend** -- the eval replays a fixture when one exists for the case, and the checked-in numbers are reproducible from the checked-in fixtures.

## What's committed

Real responses captured from three current Claude models over the nine gold cases in `../cases/`, one fixture per (model, case):

- `claude-opus-4-8` -- 98.1% field accuracy, hallucinated 2
- `claude-sonnet-5` -- 99.1% field accuracy, hallucinated 1
- `claude-haiku-4-5` -- 93.5% field accuracy, wrong 6, hallucinated 1

Fixtures are keyed by model, so each model keeps its own set; switching `MODEL` replays that model's recordings. The per-model comparison table in `../../README.md` is computed from exactly these files.

## Recording / refreshing

With credentials available (an `ANTHROPIC_API_KEY`, or an `ant auth login` profile the SDK reads automatically), capture fresh responses -- this overwrites the fixtures for the current `MODEL`:

```sh
RECORD=1 bun run eval                          # record claude-opus-4-8 (default)
MODEL=claude-sonnet-5 RECORD=1 bun run eval    # record a different model
MODEL=claude-haiku-4-5 RECORD=1 bun run eval
```

Then re-run without `RECORD` to replay them offline. `REPLAY_ONLY=1` turns a missing fixture into a hard error instead of a silent live call -- the guard CI uses to stay offline and free.
