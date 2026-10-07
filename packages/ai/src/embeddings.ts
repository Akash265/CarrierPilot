import type { Env } from "@ai-career/config";
import type { BudgetEnv } from "./usage/budget";
import { trackAiCall } from "./usage/track";
import type { AiOperation, AiUsageSink } from "./usage/types";

export class EmbeddingProviderNotImplementedError extends Error {}

/** A non-2xx Voyage response. The message carries the status only: the body can echo the embedded text (CLAUDE.md §9). */
export class VoyageRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Voyage embeddings request failed: ${status}`);
    this.name = "VoyageRequestError";
    this.status = status;
  }
}

export interface EmbedUsage {
  sink: AiUsageSink;
  operation: AiOperation;
}

export interface EmbedDeps {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1); drives the ±20% backoff jitter. */
  random?: () => number;
  clock?: () => number;
}

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 30_000;

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/** Seconds-valued retry-after only (capped); an HTTP-date or garbage value falls back to exponential backoff. */
function retryDelayMs(attempt: number, retryAfter: string | null, random: () => number): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter.trim());
  if (retryAfter !== null && retryAfter.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return Math.round(BASE_DELAY_MS * 2 ** (attempt - 1) * (0.8 + 0.4 * random()));
}

function voyageErrorCode(error: unknown): string {
  if (error instanceof VoyageRequestError) return `voyage:${error.status}`;
  if (error instanceof TypeError) return "network";
  return "error";
}

/**
 * Embeds `texts` with Voyage (Phase 11a design §7): one budget check, then up to 3 attempts retrying
 * network errors, 429 and 5xx (never other 4xx), honouring a seconds-valued retry-after. One `ai_calls`
 * row per call, labelled with `usage.operation`. Empty input returns [] without a call or a row.
 */
export async function embedTexts(
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL"> & BudgetEnv,
  texts: string[],
  usage: EmbedUsage,
  deps: EmbedDeps = {}
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (env.EMBEDDING_PROVIDER !== "voyage") {
    throw new EmbeddingProviderNotImplementedError(`EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER} has no implementation yet`);
  }
  const fetchFn = deps.fetchFn ?? ((url: string, init: RequestInit) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;

  return trackAiCall(
    {
      sink: usage.sink, env, operation: usage.operation, provider: "voyage", model: env.VOYAGE_EMBEDDING_MODEL,
      clock: deps.clock ?? Date.now, errorCodeOf: voyageErrorCode,
    },
    async () => {
      for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
          response = await fetchFn(VOYAGE_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: texts, model: env.VOYAGE_EMBEDDING_MODEL }),
          });
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS) throw error;
          await sleep(retryDelayMs(attempt, null, random));
          continue;
        }
        if (response.ok) {
          const body = (await response.json()) as { data: { embedding: number[] }[]; usage?: { total_tokens?: number } };
          const totalTokens = body.usage?.total_tokens;
          const usageReported = typeof totalTokens === "number";
          return {
            result: body.data.map((item) => item.embedding),
            usage: { inputTokens: usageReported ? totalTokens : 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, webSearchRequests: 0 },
            usageReported,
          };
        }
        await response.body?.cancel().catch(() => undefined);
        if (!isRetryableStatus(response.status) || attempt >= MAX_ATTEMPTS) throw new VoyageRequestError(response.status);
        await sleep(retryDelayMs(attempt, response.headers.get("retry-after"), random));
      }
    }
  );
}
