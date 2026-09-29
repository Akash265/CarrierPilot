import Anthropic from "@anthropic-ai/sdk";
import { withUserContext, type DbClient } from "@ai-career/db";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import type { CompanyResearchWithFacts } from "../research/ensureCompanyResearch";
import { generateCoverLetter, CoverLetterGenerationValidationError } from "../coverLetter/generateCoverLetter";
import { applyCoverLetterGuard, type CoverLetterGuardResult } from "../coverLetter/applyCoverLetterGuard";
import { ApplicationGenerationError } from "./generationError";
import { prepareApplicationContext, type PrepareApplicationContextOptions } from "./prepareApplicationContext";
import { insertCoverLetterVersion, type CoverLetterRow } from "./insertCoverLetterVersion";

export interface RunCoverLetterGenerationResult {
  coverLetter: CoverLetterRow;
  research: CompanyResearchWithFacts;
}

/** Phase 7c design §4.2: shared context → fast-tier call → citation guard → D44 → locked insert. */
export async function runCoverLetterGeneration(db: DbClient, opts: PrepareApplicationContextOptions): Promise<RunCoverLetterGenerationResult> {
  const { userId, jobId, anthropicClient, env } = opts;
  const { job, snapshot, research, evidence } = await prepareApplicationContext(db, opts);

  let guard: CoverLetterGuardResult;
  try {
    const draft = await generateCoverLetter(anthropicClient, env, { jobTitle: job.title, companyName: job.companyName, evidence });
    guard = applyCoverLetterGuard(evidence, draft);
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof CoverLetterGenerationValidationError) {
      throw new ApplicationGenerationError("unknown");
    }
    throw error;
  }

  // D44 choke point: model-written paragraph text goes into jsonb.
  if (hasUnsafeText(guard.paragraphs)) throw new ApplicationGenerationError("unknown");

  const coverLetter = await withUserContext(db, userId, (tx) =>
    insertCoverLetterVersion(tx, userId, jobId, {
      origin: "generated",
      parentCoverLetterId: null,
      companyResearchId: research.research.id,
      researchStatusSnapshot: research.research.status,
      researchedAtSnapshot: research.research.researchedAt,
      paragraphs: guard.paragraphs,
      requiresReview: guard.requiresReview,
      sourceProfileContentHash: snapshot.contentHash,
      generationModel: env.ANTHROPIC_MODEL_FAST,
    })
  );
  return { coverLetter, research };
}
