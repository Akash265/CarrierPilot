import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, numeric, boolean, timestamp, index, check } from "drizzle-orm/pg-core";

/**
 * Phase 11a design §8. One row per logical AI call (Anthropic messages.create or Voyage embeddings), written
 * by DbUsageSink. Metadata only -- never prompt/response text or profile fields -- so it is not part of the
 * retention sweep. Append-only: the custom migration 0029 gives the app role SELECT and INSERT policies only,
 * so UPDATE and DELETE match no rows. `operation` is deliberately not a CHECK: new operations are added in
 * packages/ai (AI_OPERATIONS) without a migration.
 */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    operation: text("operation").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    webSearchRequests: integer("web_search_requests").notNull().default(0),
    latencyMs: integer("latency_ms").notNull(),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }).notNull(),
    priceKnown: boolean("price_known").notNull(),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
  },
  (t) => ({
    userCreatedIdx: index("ai_calls_user_created_idx").on(t.userId, t.createdAt.desc()),
    providerValid: check("ai_calls_provider_valid", sql`${t.provider} IN ('anthropic', 'voyage')`),
    outcomeValid: check("ai_calls_outcome_valid", sql`${t.outcome} IN ('ok', 'api_error', 'blocked')`),
    countsNonNegative: check(
      "ai_calls_counts_non_negative",
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cacheReadTokens} >= 0 AND ${t.cacheCreationTokens} >= 0 AND ${t.webSearchRequests} >= 0 AND ${t.latencyMs} >= 0`
    ),
    costNonNegative: check("ai_calls_cost_non_negative", sql`${t.estimatedCostUsd} >= 0`),
  })
);
