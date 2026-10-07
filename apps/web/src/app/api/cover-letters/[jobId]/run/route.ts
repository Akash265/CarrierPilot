// apps/web/src/app/api/cover-letters/[jobId]/run/route.ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { AiBudgetExceededError, createAnthropicFor } from "@ai-career/ai";
import { runCoverLetterGeneration, ApplicationGenerationError } from "@ai-career/application-package";
import { toCoverLetterView } from "../../../../../lib/coverLetter/serializeCoverLetter";
import { toResearchView } from "../../../../../lib/applicationPitch/serializePitch";
import { createUsageSink } from "../../../../../lib/aiUsage/createUsageSink";
import { budgetExceededResponse } from "../../../../../lib/aiUsage/budgetResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await runCoverLetterGeneration(db, {
      userId: env.DEFAULT_USER_ID,
      jobId,
      anthropicFor: createAnthropicFor(env, createUsageSink(db, env)),
      env,
    });
    return NextResponse.json({ coverLetter: toCoverLetterView(result.coverLetter), research: toResearchView(result.research) }, { status: 201 });
  } catch (error) {
    if (error instanceof AiBudgetExceededError) return budgetExceededResponse(error);
    if (error instanceof ApplicationGenerationError) {
      if (error.errorClass === "no_match") return NextResponse.json({ error: 'Run "Find Matches" for this job first' }, { status: 404 });
      if (error.errorClass === "not_eligible") return NextResponse.json({ error: "This job is not an eligible match" }, { status: 400 });
      if (error.errorClass === "no_profile") return NextResponse.json({ error: "Confirm your profile first" }, { status: 409 });
      return NextResponse.json({ error: "Cover letter generation failed. Try again." }, { status: 502 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
