import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { buildOutcomeDataset, computeInsights, loadInsightInputs } from "@ai-career/insights";

/**
 * Phase 10a spec §7.1. Computed on every request from the stored applications (no cache, no table): at a
 * single user's scale this is milliseconds, and it can never go stale. Aggregates only -- no notes,
 * recruiter details, URLs or application ids (spec §8).
 */
export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const inputs = await loadInsightInputs(db, env.DEFAULT_USER_ID);
    const records = buildOutcomeDataset(inputs, { now: new Date(), undecidedDays: env.OUTCOME_UNDECIDED_DAYS });
    const insights = computeInsights(records, { minBucket: env.INSIGHTS_MIN_BUCKET });
    return NextResponse.json({
      settings: { undecidedDays: env.OUTCOME_UNDECIDED_DAYS, minBucket: env.INSIGHTS_MIN_BUCKET },
      ...insights,
    });
  } finally {
    await closeDbClient(db);
  }
}
