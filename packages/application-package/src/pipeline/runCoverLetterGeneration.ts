import Anthropic from "@anthropic-ai/sdk";
import { withUserContext, type DbClient } from "@ai-career/db";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import type { CompanyResearchWithFacts } from "../research/ensureCompanyResearch";
import { generateCoverLetter, CoverLetterGenerationValidationError } from "../coverLetter/generateCoverLetter";
import { applyCoverLetterGuard, type CoverLetterGuardResult } from "../coverLetter/applyCoverLetterGuard";
import { findGapTermMentions } from "../coverLetter/findGapTermMentions";
import { computeGapTerms } from "../interviewPrep/computeGapTerms";
import { ApplicationGenerationError } from "./generationError";
import { prepareApplicationContext, type PrepareApplicationContextOptions } from "./prepareApplicationContext";
import { insertCoverLetterVersion, type CoverLetterRow } from "./insertCoverLetterVersion";

export interface RunCoverLetterGenerationResult {
  coverLetter: CoverLetterRow;
  research: CompanyResearchWithFacts;
}

/**
 * Phase 7c design §4.2: shared context → gap terms → fast-tier call → citation guard → per-paragraph
 * gap mentions (missingTermMentions, D106) and the review flag they raise (D101) → D44 → locked insert.
 */
export async function runCoverLetterGeneration(db: DbClient, opts: PrepareApplicationContextOptions): Promise<RunCoverLetterGenerationResult> {
  const { userId, jobId, anthropicClient, env } = opts;
  const { job, snapshot, research, requirements, evidence } = await prepareApplicationContext(db, opts);
  // D101: every missing required term (not capped) -- a later paragraph naming one needs the user's review.
  const gapTerms = computeGapTerms(requirements, snapshot.catalog);

  let guard: CoverLetterGuardResult;
  try {
    const draft = await generateCoverLetter(anthropicClient, env, { jobTitle: job.title, companyName: job.companyName, evidence });
    guard = applyCoverLetterGuard(evidence, draft);
    // D106: the cause is stored per paragraph so the review banner can name it.
    const mentions = findGapTermMentions(guard.paragraphs, gapTerms);
    guard = {
      paragraphs: guard.paragraphs.map((p, i) => ({ ...p, missingTermMentions: mentions[i] })),
      requiresReview: guard.requiresReview || mentions.some((terms) => terms.length > 0),
    };
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
