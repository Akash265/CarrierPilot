import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { ConfirmCareerGoalSchema } from "../../../../lib/career-goal/careerGoalConstraintsSchema";
import {
  confirmCareerGoal,
  CareerGoalNotFoundError,
  CareerGoalStateError,
} from "../../../../lib/career-goal/saveCareerGoal";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";
import { withRateLimit } from "../../../../lib/http/rateLimit";

async function handlePOST(request: Request) {
  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = ConfirmCareerGoalSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }

  try {
    await confirmCareerGoal(env, parsed.data.goalId, parsed.data.constraints);
  } catch (error) {
    if (error instanceof CareerGoalNotFoundError) {
      return NextResponse.json({ error: "Career goal not found" }, { status: 404 });
    }
    if (error instanceof CareerGoalStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ status: "confirmed" });
}

export const POST = withRouteErrors("/api/career-goal/confirm", withRateLimit("ai", "/api/career-goal/confirm", handlePOST));
