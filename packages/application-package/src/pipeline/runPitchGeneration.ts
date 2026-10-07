import Anthropic from "@anthropic-ai/sdk";
import { withUserContext, type DbClient } from "@ai-career/db";
import type { AnthropicFor } from "@ai-career/ai";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import type { CompanyResearchWithFacts } from "../research/ensureCompanyResearch";
import { generatePitch, PitchGenerationValidationError } from "../pitch/generatePitch";
import { applyPitchGuard, type PitchGuardResult } from "../pitch/applyPitchGuard";
import { insertPitchVersion, type ApplicationPitchRow } from "./insertPitchVersion";
import { ApplicationGenerationError, type ApplicationGenerationErrorClass } from "./generationError";
import { prepareApplicationContext, type ApplicationContextEnv } from "./prepareApplicationContext";

/** Kept as aliases of the shared class so existing `instanceof PitchGenerationError` checks keep working. */
export const PitchGenerationError = ApplicationGenerationError;
export type PitchGenerationError = ApplicationGenerationError;
export type PitchGenerationErrorClass = ApplicationGenerationErrorClass;
export type RunPitchGenerationEnv = ApplicationContextEnv;

export interface RunPitchGenerationOptions {
  userId: string;
  jobId: string;
  anthropicFor: AnthropicFor;
  env: RunPitchGenerationEnv;
}

export interface RunPitchGenerationResult {
  pitch: ApplicationPitchRow;
  research: CompanyResearchWithFacts;
}

/**
 * One user-triggered pitch generation (Phase 7a design §4). prepareApplicationContext runs the gates,
 * research, requirements and evidence index; this adds the pitch call, the guard and the locked insert.
 */
export async function runPitchGeneration(db: DbClient, opts: RunPitchGenerationOptions): Promise<RunPitchGenerationResult> {
  const { userId, jobId, anthropicFor, env } = opts;
  const { job, snapshot, research, evidence } = await prepareApplicationContext(db, opts);

  let guard: PitchGuardResult;
  try {
    const draft = await generatePitch(anthropicFor("pitch_generation"), env, { jobTitle: job.title, companyName: job.companyName, evidence });
    guard = applyPitchGuard(evidence, draft);
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof PitchGenerationValidationError) {
      throw new ApplicationGenerationError("unknown");
    }
    throw error;
  }

  // D44 choke point: model-written bullet text goes into jsonb.
  if (hasUnsafeText(guard.bullets)) throw new ApplicationGenerationError("unknown");

  const pitch = await withUserContext(db, userId, (tx) =>
    insertPitchVersion(tx, userId, jobId, {
      origin: "generated",
      parentPitchId: null,
      companyResearchId: research.research.id,
      researchStatusSnapshot: research.research.status,
      researchedAtSnapshot: research.research.researchedAt,
      bullets: guard.bullets,
      requiresReview: guard.requiresReview,
      sourceProfileContentHash: snapshot.contentHash,
      generationModel: env.ANTHROPIC_MODEL_FAST,
    })
  );
  return { pitch, research };
}
