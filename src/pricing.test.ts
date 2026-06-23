import { describe, expect, test } from "bun:test";
import { costUsd, PRICING } from "./pricing";

describe("costUsd", () => {
  test("unknown model yields null (reported, never guessed as 0)", () => {
    // null vs 0 is the load-bearing distinction: a guessed 0 would silently
    // under-report real spend in every eval/batch summary.
    expect(costUsd("gpt-4o", { input_tokens: 1000, output_tokens: 1000 })).toBeNull();
    expect(costUsd("", { input_tokens: 1000, output_tokens: 1000 })).toBeNull();
  });

  test("prices a known model per 1,000,000 tokens at its (input, output) rate", () => {
    // opus-4-8 is (5, 25)/M -> (3000*5 + 1000*25)/1e6 = 0.04 exactly
    expect(costUsd("claude-opus-4-8", { input_tokens: 3000, output_tokens: 1000 })).toBe(0.04);
  });

  test("input and output tokens bill at different rates", () => {
    // fable-5 is (10, 50)/M -> (100*10 + 100*50)/1e6 = 0.006; output is NOT the input rate
    expect(costUsd("claude-fable-5", { input_tokens: 100, output_tokens: 100 })).toBeCloseTo(0.006, 10);
  });

  test("zero usage on a known model costs exactly 0 (not null)", () => {
    // distinguishes 'known model, no spend' (0) from 'unknown model' (null)
    expect(costUsd("claude-haiku-4-5", { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });

  test("every model in the pricing table prices without returning null", () => {
    // guards against adding a model to the schema/extract path but forgetting its price row
    for (const model of Object.keys(PRICING)) {
      expect(costUsd(model, { input_tokens: 1, output_tokens: 1 })).not.toBeNull();
    }
  });
});
