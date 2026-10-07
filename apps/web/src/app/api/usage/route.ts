import { NextResponse } from "next/server";
import { gte } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { utcMonthStart } from "@ai-career/ai";
import { summarizeUsage } from "../../../lib/aiUsage/summarizeUsage";

const { aiCalls } = schema;

/**
 * Phase 11a design §9. Read-only: this UTC month's ai_calls rows summarized on every request (a single
 * user's month is at most thousands of rows). Metadata only -- the table holds no prompt or response text.
 */
export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  const now = new Date();
  try {
    const rows = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .select({
          createdAt: aiCalls.createdAt,
          operation: aiCalls.operation,
          provider: aiCalls.provider,
          model: aiCalls.model,
          inputTokens: aiCalls.inputTokens,
          outputTokens: aiCalls.outputTokens,
          webSearchRequests: aiCalls.webSearchRequests,
          estimatedCostUsd: aiCalls.estimatedCostUsd,
          priceKnown: aiCalls.priceKnown,
          outcome: aiCalls.outcome,
          errorCode: aiCalls.errorCode,
        })
        .from(aiCalls)
        .where(gte(aiCalls.createdAt, utcMonthStart(now)))
    );
    return NextResponse.json(summarizeUsage(rows.map((r) => ({ ...r, estimatedCostUsd: Number(r.estimatedCostUsd) })), env, now));
  } finally {
    await closeDbClient(db);
  }
}
