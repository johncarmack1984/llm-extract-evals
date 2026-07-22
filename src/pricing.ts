/**
 * Per-model token pricing in USD per 1,000,000 tokens, as (input, output).
 * Source: Anthropic published pricing, current as of 2026-07 (standard rates;
 * Sonnet 5's introductory $2/$10 through 2026-08-31 is not reflected here so
 * the number stays durable). Update if rates change -- an unknown model yields
 * a null cost (reported, not guessed).
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type Usage = { input_tokens: number; output_tokens: number };

/** USD cost for a token usage on a model, or null if the model's price is unknown. */
export function costUsd(model: string, usage: Usage): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000;
}
