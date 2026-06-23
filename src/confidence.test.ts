import { describe, expect, test } from "bun:test";
import { tallyConfidence } from "./confidence";
import type { InterconnectionStudy } from "./schema";

// Missing fields default to undefined -> norm "null", i.e. unanimous "not stated".
const rec = (o: Record<string, unknown>) => o as unknown as InterconnectionStudy;

describe("tallyConfidence", () => {
  test("unanimous agreement -> confidence 1.0, nothing flagged", () => {
    const samples = [rec({ capacity_mw: 250 }), rec({ capacity_mw: 250 }), rec({ capacity_mw: 250 })];
    const { data, confidence, low_confidence } = tallyConfidence(samples);
    expect(data.capacity_mw).toBe(250);
    expect(confidence.capacity_mw).toBe(1);
    expect(low_confidence).not.toContain("capacity_mw");
  });

  test("majority value wins; sub-threshold agreement is flagged for review", () => {
    const samples = [rec({ capacity_mw: 250 }), rec({ capacity_mw: 250 }), rec({ capacity_mw: 300 })];
    const { data, confidence, low_confidence } = tallyConfidence(samples, 0.67);
    expect(data.capacity_mw).toBe(250); // 2 of 3
    expect(confidence.capacity_mw).toBeCloseTo(0.667, 2);
    expect(low_confidence).toContain("capacity_mw"); // 0.667 < 0.67
  });

  test("a field unanimous across the split stays high-confidence", () => {
    const samples = [rec({ capacity_mw: 250, iso_rto: "ERCOT" }), rec({ capacity_mw: 300, iso_rto: "ERCOT" })];
    const { confidence, low_confidence } = tallyConfidence(samples, 0.67);
    expect(confidence.iso_rto).toBe(1);
    expect(low_confidence).toContain("capacity_mw"); // 0.5 split
    expect(low_confidence).not.toContain("iso_rto");
  });

  test("normalization counts case/whitespace variants as agreement", () => {
    const samples = [rec({ iso_rto: "ERCOT" }), rec({ iso_rto: "ercot" }), rec({ iso_rto: " ERCOT " })];
    const { confidence, low_confidence } = tallyConfidence(samples);
    expect(confidence.iso_rto).toBe(1);
    expect(low_confidence).not.toContain("iso_rto");
  });

  test("a value-vs-null split surfaces as low confidence (the unsafe case)", () => {
    const samples = [
      rec({ network_upgrade_cost_usd: 1_000_000 }),
      rec({ network_upgrade_cost_usd: null }),
      rec({ network_upgrade_cost_usd: null }),
    ];
    const { data, confidence } = tallyConfidence(samples, 0.67);
    expect(data.network_upgrade_cost_usd).toBeNull(); // 2 of 3 say not-stated
    expect(confidence.network_upgrade_cost_usd).toBeCloseTo(0.667, 2);
  });

  test("a value-vs-null tie resolves to null regardless of run order (safe consensus)", () => {
    // a 1-1 deadlock between a stated value and 'not stated' must not coin-flip
    // to the value -- trusting an invented number is the unsafe error here.
    const forward = tallyConfidence([rec({ network_upgrade_cost_usd: 5_000_000 }), rec({ network_upgrade_cost_usd: null })], 0.67);
    const reverse = tallyConfidence([rec({ network_upgrade_cost_usd: null }), rec({ network_upgrade_cost_usd: 5_000_000 })], 0.67);
    expect(forward.data.network_upgrade_cost_usd).toBeNull();
    expect(reverse.data.network_upgrade_cost_usd).toBeNull();
    expect(forward.confidence.network_upgrade_cost_usd).toBe(0.5);
    expect(forward.low_confidence).toContain("network_upgrade_cost_usd"); // 0.5 < 0.67
  });

  test("a tie between two stated values stays deterministic (first-seen, no null bias)", () => {
    // no null in the tie, so the safety bias doesn't apply; the result is stable
    const { data, low_confidence } = tallyConfidence([rec({ iso_rto: "ERCOT" }), rec({ iso_rto: "PJM" })], 0.67);
    expect(data.iso_rto).toBe("ERCOT");
    expect(low_confidence).toContain("iso_rto"); // still low confidence at 0.5
  });

  test("a field absent from every sample is unanimous null, not flagged", () => {
    // missing -> norm 'null' for every run -> confidence 1.0, normalized to literal null
    const { data, confidence, low_confidence } = tallyConfidence([rec({ capacity_mw: 250 }), rec({ capacity_mw: 250 })], 0.67);
    expect(data.developer).toBeNull();
    expect(confidence.developer).toBe(1);
    expect(low_confidence).not.toContain("developer");
  });

  test("a single sample yields confidence 1.0 for every field, nothing flagged", () => {
    const { confidence, low_confidence } = tallyConfidence([rec({ capacity_mw: 250 })], 0.67);
    expect(confidence.capacity_mw).toBe(1);
    expect(low_confidence).toEqual([]);
  });

  test("threshold is an exclusive floor: confidence == threshold is not flagged", () => {
    // 1 of 2 = 0.5 at threshold 0.5 stays off the review queue (strict <)
    const { low_confidence } = tallyConfidence([rec({ status: "active" }), rec({ status: "withdrawn" })], 0.5);
    expect(low_confidence).not.toContain("status");
  });
});
