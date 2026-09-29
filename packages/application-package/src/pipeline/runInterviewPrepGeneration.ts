import Anthropic from "@anthropic-ai/sdk";
import { withUserContext, type DbClient } from "@ai-career/db";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import type { CompanyResearchWithFacts } from "../research/ensureCompanyResearch";
import { computeGapTerms } from "../interviewPrep/computeGapTerms";
import { generateInterviewPrep, InterviewPrepGenerationValidationError } from "../interviewPrep/generateInterviewPrep";
import { applyInterviewPrepGuard, type InterviewPrepGuardResult } from "../interviewPrep/applyInterviewPrepGuard";
import { ApplicationGenerationError } from "./generationError";
import { prepareApplicationContext, type PrepareApplicationContextOptions } from "./prepareApplicationContext";
import { insertInterviewPrepVersion, type InterviewPrepRow } from "./insertInterviewPrepVersion";

export interface RunInterviewPrepGenerationResult {
  interviewPrep: InterviewPrepRow;
  research: CompanyResearchWithFacts;
}

/** Phase 7c design §4.3: shared context → deterministic gap terms → research-tier call → guard → D44 → locked insert. */
export async function runInterviewPrepGeneration(db: DbClient, opts: PrepareApplicationContextOptions): Promise<RunInterviewPrepGenerationResult> {
  const { userId, jobId, anthropicClient, env } = opts;
  const { job, snapshot, research, requirements, evidence } = await prepareApplicationContext(db, opts);
  const gapTerms = computeGapTerms(requirements, snapshot.catalog);

  let guard: InterviewPrepGuardResult;
  try {
    const draft = await generateInterviewPrep(anthropicClient, env, { jobTitle: job.title, companyName: job.companyName, evidence, gapTerms });
    guard = applyInterviewPrepGuard(evidence, gapTerms, draft);
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof InterviewPrepGenerationValidationError) {
      throw new ApplicationGenerationError("unknown");
    }
    throw error;
  }

  // D44 choke point: every model-written string in the pack goes into jsonb.
  if (hasUnsafeText(guard.sections)) throw new ApplicationGenerationError("unknown");

  const interviewPrep = await withUserContext(db, userId, (tx) =>
    insertInterviewPrepVersion(tx, userId, jobId, {
      companyResearchId: research.research.id,
      researchStatusSnapshot: research.research.status,
      researchedAtSnapshot: research.research.researchedAt,
      sections: guard.sections,
      gapTermsSnapshot: gapTerms.map((g) => g.term),
      requiresReview: guard.requiresReview,
      sourceProfileContentHash: snapshot.contentHash,
      generationModel: env.ANTHROPIC_MODEL_RESEARCH,
    })
  );
  return { interviewPrep, research };
}
