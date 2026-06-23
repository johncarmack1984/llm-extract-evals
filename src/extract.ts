import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { InterconnectionStudy } from "./schema";
import type { Usage } from "./pricing";

export const MODEL = process.env.MODEL ?? "claude-opus-4-8";
const MAX_RETRIES = 2;

// Reads ANTHROPIC_API_KEY from the environment (bun auto-loads .env). Lazy so
// that replaying fixtures needs no key -- the client is only built on a live call.
let _client: Anthropic | undefined;
const client = () => (_client ??= new Anthropic());

const SYSTEM = [
  "You extract structured data from grid interconnection documents.",
  "Return only what the document states. If a field is not stated, return null --",
  "do not guess, infer, or fill from prior knowledge, and treat placeholders like",
  "'TBD' or 'redacted' as not stated. Normalize units: capacity in MW, voltage in",
  "kV, cost in US dollars with separators and symbols removed ($42.7 million -> 42700000).",
].join(" ");

export type ExtractResult =
  | {
      ok: true;
      data: InterconnectionStudy;
      attempts: number;
      model: string;
      usage: Usage;
      latency_ms: number;
    }
  | { ok: false; error: string; attempts: number; model: string };

/**
 * Extract one document into the schema. Structured outputs constrain the
 * response to the schema; a schema miss is the one failure we retry here,
 * because the SDK can't see it. Transient HTTP failures (429/5xx/connection)
 * are already retried with backoff inside the SDK, and a refusal or a terminal
 * error fails fast -- so this loop does not re-issue those, which would only
 * stack a second round of attempts on top of the SDK's and multiply spend. On
 * success we also surface token usage and wall-clock latency so the eval/batch
 * can report cost and timing.
 */
export async function extract(docText: string): Promise<ExtractResult> {
  let lastError = "unknown error";
  const maxAttempts = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const started = performance.now();
      const response = await client().messages.parse({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        messages: [{ role: "user", content: docText }],
        output_config: { format: zodOutputFormat(InterconnectionStudy) },
      });
      const latency_ms = Math.round(performance.now() - started);

      if (response.stop_reason === "refusal") {
        return { ok: false, error: "model refused the request", attempts: attempt, model: MODEL };
      }

      const parsed = response.parsed_output;
      if (parsed) {
        const usage: Usage = {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        };
        return { ok: true, data: parsed, attempts: attempt, model: MODEL, usage, latency_ms };
      }

      lastError = "response did not satisfy the schema"; // only this is retried
    } catch (err) {
      // Any thrown error stops here. Transient failures (429/5xx/connection) were
      // already retried with backoff inside the SDK, so a throw means they are
      // exhausted; terminal errors (bad request, auth, permission, not found)
      // won't improve either. Re-issuing at this layer would multiply the SDK's
      // attempts -- and the spend -- for no gain.
      return { ok: false, error: err instanceof Error ? err.message : String(err), attempts: attempt, model: MODEL };
    }
  }

  return { ok: false, error: lastError, attempts: maxAttempts, model: MODEL };
}
