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
});
