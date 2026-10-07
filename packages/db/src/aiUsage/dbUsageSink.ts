import { gte, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { withUserContext } from "../rls";
import { aiCalls } from "../schema/aiCalls";

/**
 * Structurally the same as packages/ai's AiCallEvent. Declared here rather than imported so the lowest
 * layer (db) never depends on the AI package; apps/web and the matching worker assign DbUsageSink to
 * AiUsageSink, and that property-typed interface makes the compiler reject any drift between the two.
 */
export interface AiCallRecord {
  id: string;
  createdAt: Date;
  operation: string;
  provider: "anthropic" | "voyage";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests: number;
  latencyMs: number;
  estimatedCostUsd: number;
  priceKnown: boolean;
  outcome: "ok" | "api_error" | "blocked";
  errorCode: string | null;
}

/** Writes and sums `ai_calls` for one user, each statement in its own RLS-scoped transaction. */
export class DbUsageSink {
  constructor(
    private readonly db: DbClient,
    private readonly userId: string
  ) {}

  spendSinceUsd = async (since: Date): Promise<number> => {
    const [row] = await withUserContext(this.db, this.userId, (tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${aiCalls.estimatedCostUsd}), 0)::text` })
        .from(aiCalls)
        .where(gte(aiCalls.createdAt, since))
    );
    return Number(row?.total ?? 0);
  };

  record = async (event: AiCallRecord): Promise<void> => {
    await withUserContext(this.db, this.userId, (tx) =>
      tx.insert(aiCalls).values({ ...event, estimatedCostUsd: event.estimatedCostUsd.toFixed(6) })
    );
  };
}
