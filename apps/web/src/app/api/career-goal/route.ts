import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { createDbClient, closeDbClient, withUserContext } from "@ai-career/db";
import { getCareerGoalState } from "../../../lib/career-goal/serializeCareerGoal";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

async function handleGET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const state = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => getCareerGoalState(tx));
    return NextResponse.json(state);
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/career-goal", handleGET);
