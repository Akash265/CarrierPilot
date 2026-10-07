import type { AiProvider, UsageCounts } from "./types";

/**
 * Phase 11a cost estimates (design §4.2). USD per million tokens. Sources, checked 2026-10-07:
 * Anthropic model pricing (claude-api reference, cached 2026-06-24), Anthropic web-search docs
 * ($10 per 1,000 searches), Voyage pricing page. These are ESTIMATES, not the invoice -- the /usage
 * page says so. When a price changes or a model is added, edit this table; an unpriced model is never
 * free (see UNKNOWN_* below).
 */
export interface ModelPrice {
  provider: AiProvider;
  /** Matches the model id exactly, or as a prefix followed by "-" (so dated ids match their family). */
  prefix: string;
  inputPerMTok: number;
  /** 0 for embedding models, which have no output tokens. */
  outputPerMTok: number;
}

export const MODEL_PRICES: readonly ModelPrice[] = Object.freeze([
  { provider: "anthropic", prefix: "claude-haiku-4-5", inputPerMTok: 1, outputPerMTok: 5 },
  { provider: "anthropic", prefix: "claude-sonnet-4-6", inputPerMTok: 3, outputPerMTok: 15 },
  { provider: "anthropic", prefix: "claude-sonnet-5", inputPerMTok: 2, outputPerMTok: 10 },
  { provider: "anthropic", prefix: "claude-opus-4-6", inputPerMTok: 5, outputPerMTok: 25 },
  { provider: "anthropic", prefix: "claude-opus-4-7", inputPerMTok: 5, outputPerMTok: 25 },
  { provider: "anthropic", prefix: "claude-opus-4-8", inputPerMTok: 5, outputPerMTok: 25 },
  { provider: "anthropic", prefix: "claude-opus-5", inputPerMTok: 5, outputPerMTok: 25 },
  { provider: "anthropic", prefix: "claude-opus-5-5", inputPerMTok: 4, outputPerMTok: 20 },
  { provider: "anthropic", prefix: "claude-fable-5", inputPerMTok: 10, outputPerMTok: 50 },
  { provider: "voyage", prefix: "voyage-3.5", inputPerMTok: 0.06, outputPerMTok: 0 },
  { provider: "voyage", prefix: "voyage-3.5-lite", inputPerMTok: 0.02, outputPerMTok: 0 },
]);

/** Prompt-cache multipliers on the input rate (5-minute TTL writes -- the only TTL this app could use). */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** $10 per 1,000 searches, in micro-dollars per search. */
export const WEB_SEARCH_MICRO_USD = 10_000;

function matchesPrefix(model: string, prefix: string): boolean {
  return model === prefix || model.startsWith(`${prefix}-`);
}

/** The longest matching prefix for this provider, or null. */
export function findPrice(provider: AiProvider, model: string): ModelPrice | null {
  let best: ModelPrice | null = null;
  for (const price of MODEL_PRICES) {
    if (price.provider !== provider || !matchesPrefix(model, price.prefix)) continue;
    if (!best || price.prefix.length > best.prefix.length) best = price;
  }
  return best;
}

/** An unknown model is priced at the provider's most expensive known rates, so a model swap can never look free. */
function mostExpensive(provider: AiProvider): ModelPrice {
  const candidates = MODEL_PRICES.filter((p) => p.provider === provider);
  return {
    provider,
    prefix: "(unknown)",
    inputPerMTok: Math.max(...candidates.map((p) => p.inputPerMTok)),
    outputPerMTok: Math.max(...candidates.map((p) => p.outputPerMTok)),
  };
}

/**
 * $X per million tokens is X micro-dollars per token, so the sum below is in micro-dollars; it is rounded
 * to whole micro-dollars (the column is numeric(12,6)) before converting to dollars.
 */
export function estimateCostUsd(
  provider: AiProvider,
  model: string,
  usage: UsageCounts
): { costUsd: number; priceKnown: boolean } {
  const known = findPrice(provider, model);
  const price = known ?? mostExpensive(provider);
  const microUsd =
    usage.inputTokens * price.inputPerMTok +
    usage.outputTokens * price.outputPerMTok +
    usage.cacheReadTokens * price.inputPerMTok * CACHE_READ_MULTIPLIER +
    usage.cacheCreationTokens * price.inputPerMTok * CACHE_WRITE_MULTIPLIER +
    usage.webSearchRequests * WEB_SEARCH_MICRO_USD;
  return { costUsd: Math.round(microUsd) / 1e6, priceKnown: known !== null };
}
