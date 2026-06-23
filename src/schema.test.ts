import { describe, expect, test } from "bun:test";
import { InterconnectionStudy, FIELDS } from "./schema";

// A fully-null record (every nullable field "not stated") with the one required
// field set -- the baseline each case extends.
const base = { ...Object.fromEntries(FIELDS.map((f) => [f, null])), project_name: "X" };
const parses = (o: Record<string, unknown>) => InterconnectionStudy.safeParse({ ...base, ...o }).success;

describe("InterconnectionStudy schema", () => {
  test("FIELDS lists every key in declaration order (the eval scores in this order)", () => {
    expect(FIELDS).toEqual([
      "project_name",
      "developer",
      "capacity_mw",
      "resource_type",
      "voltage_kv",
      "point_of_interconnection",
      "queue_id",
      "iso_rto",
      "study_type",
      "in_service_date",
      "status",
      "network_upgrade_cost_usd",
    ]);
  });

  test("accepts a record with project_name set and everything else null", () => {
    expect(parses({})).toBe(true);
  });

  test("project_name is required (not nullable)", () => {
    expect(InterconnectionStudy.safeParse({ ...base, project_name: null }).success).toBe(false);
  });

  test("in_service_date accepts null or a YYYY-MM-DD date", () => {
    expect(parses({ in_service_date: null })).toBe(true);
    expect(parses({ in_service_date: "2027-03-15" })).toBe(true);
  });

  test("in_service_date rejects a partial or free-form date (must be null, not a partial string)", () => {
    // the field's contract: a month/year-only date is 'not stated' -> null, never "2027-03"
    expect(parses({ in_service_date: "2027-03" })).toBe(false);
    expect(parses({ in_service_date: "2027" })).toBe(false);
    expect(parses({ in_service_date: "March 2027" })).toBe(false);
  });

  test("enum fields reject out-of-set values", () => {
    expect(parses({ iso_rto: "TVA" })).toBe(false);
    expect(parses({ resource_type: "nuclear" })).toBe(false);
  });
});
