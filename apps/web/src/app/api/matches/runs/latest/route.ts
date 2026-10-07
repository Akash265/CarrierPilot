import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";

async function handleGET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [run] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select().from(schema.matchingRuns).orderBy(desc(schema.matchingRuns.startedAt)).limit(1)
    );
    if (!run) return NextResponse.json({ run: null });
    return NextResponse.json({
      run: {
        status: run.status,
        errorClass: run.errorClass,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        jobsEvaluated: run.jobsEvaluated,
        jobsEligible: run.jobsEligible,
        jobsExplained: run.jobsExplained,
      },
    });
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/matches/runs/latest", handleGET);
