import { z } from "zod";

/**
 * Structured target for a grid interconnection study / queue entry -- the
 * fields a developer or ISO analyst pulls off a study summary.
 *
 * Convention: `null` means "not stated in the document." The model must not
 * invent, infer, or backfill a value that the source text does not contain;
 * that distinction is what the eval (see ../README.md) measures.
 */
export const InterconnectionStudy = z.object({
  project_name: z.string().describe("Name of the generation or storage project."),
  developer: z
    .string()
    .nullable()
    .describe("Developer or interconnection customer, if a real name is given (not 'TBD')."),
  capacity_mw: z.number().nullable().describe("Nameplate capacity in megawatts (MW)."),
  resource_type: z
    .enum(["solar", "wind", "storage", "gas", "hybrid", "other"])
    .nullable()
    .describe("Primary resource type. Co-located solar-plus-storage is 'hybrid'."),
  voltage_kv: z.number().nullable().describe("Point-of-interconnection voltage in kilovolts (kV)."),
  point_of_interconnection: z
    .string()
    .nullable()
    .describe("Substation, switchyard, or line where the project ties into the grid."),
  queue_id: z.string().nullable().describe("Interconnection queue identifier, if stated."),
  iso_rto: z
    .enum(["CAISO", "ERCOT", "PJM", "MISO", "SPP", "ISO-NE", "NYISO", "other"])
    .nullable()
    .describe("Balancing authority / ISO / RTO."),
  study_type: z
    .enum(["feasibility", "system_impact", "facilities", "other"])
    .nullable()
    .describe("Interconnection study phase."),
  in_service_date: z
    .string()
    .nullable()
    .describe("In-service date as ISO 8601 (YYYY-MM-DD). Use null if only a month or year is given."),
  status: z
    .enum(["active", "withdrawn", "suspended", "in_service", "other"])
    .nullable()
    .describe("Current queue status."),
  network_upgrade_cost_usd: z
    .number()
    .nullable()
    .describe("Estimated network/transmission upgrade cost in US dollars (e.g. $42.7 million -> 42700000)."),
});

export type InterconnectionStudy = z.infer<typeof InterconnectionStudy>;

/** Ordered field list, used by the eval to score each labeled field. */
export const FIELDS = Object.keys(InterconnectionStudy.shape) as (keyof InterconnectionStudy)[];
