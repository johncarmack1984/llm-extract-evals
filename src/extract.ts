import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { InterconnectionStudy } from "./schema";

const MODEL = process.env.MODEL ?? "claude-opus-4-8";
const MAX_RETRIES = 2;

// Reads ANTHROPIC_API_KEY from the environment (bun auto-loads .env).
const client = new Anthropic();

const SYSTEM = [
  "You extract structured data from grid interconnection documents.",
  "Return only what the document states. If a field is not stated, return null --",
  "do not guess, infer, or fill from prior knowledge, and treat placeholders like",
  "'TBD' or 'redacted' as not stated. Normalize units: capacity in MW, voltage in",
  "kV, cost in US dollars with separators and symbols removed ($42.7 million -> 42700000).",
].join(" ");

export type ExtractResult =
  | { ok: true; data: InterconnectionStudy; attempts: number; model: string }
  | { ok: false; error: string; attempts: number; model: string };

/**
 * Extract one document into the schema. Structured outputs constrain the
 * response to the schema; on a schema miss we retry (transient), and a refusal
 * is terminal (a retry will not change it).
 */
export async function extract(docText: string): Promise<ExtractResult> {
  let lastError = "unknown error";
  const maxAttempts = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        messages: [{ role: "user", content: docText }],
        output_config: { format: zodOutputFormat(InterconnectionStudy) },
      });

      if (response.stop_reason === "refusal") {
        return { ok: false, error: "model refused the request", attempts: attempt, model: MODEL };
      }

      const parsed = response.parsed_output;
      if (parsed) return { ok: true, data: parsed, attempts: attempt, model: MODEL };

      lastError = "response did not satisfy the schema"; // transient: retry
    } catch (err) {
      // Terminal errors (bad request, auth, permission, not found) will not
      // improve on retry -- fail fast. Rate limits and 5xx fall through to retry.
      if (
        err instanceof Anthropic.BadRequestError ||
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError ||
        err instanceof Anthropic.NotFoundError
      ) {
        return { ok: false, error: err.message, attempts: attempt, model: MODEL };
      }
      lastError = err instanceof Error ? err.message : String(err); // transient: retry
    }
  }

  return { ok: false, error: lastError, attempts: maxAttempts, model: MODEL };
}
