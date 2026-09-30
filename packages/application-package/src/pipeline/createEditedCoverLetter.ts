import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import { MAX_PARAGRAPH_CHARS, type StoredCoverLetterParagraph } from "../types";
import { insertCoverLetterVersion, type CoverLetterRow } from "./insertCoverLetterVersion";

const { coverLetters } = schema;

const EditedParagraphText = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PARAGRAPH_CHARS)
  .refine((s) => !hasUnsafeText(s), { message: "contains unsupported characters" });

/** Request body for POST /api/cover-letters/[jobId]/edit. Paragraphs are in the base version's order. */
export const EditCoverLetterBodySchema = z
  .object({
    baseVersionId: z.string().uuid(),
    paragraphs: z.array(EditedParagraphText).min(4).max(5),
  })
  .strict();

export type EditCoverLetterBody = z.infer<typeof EditCoverLetterBodySchema>;

export class CoverLetterEditError extends Error {
  readonly errorClass: "base_not_found" | "paragraph_count_mismatch";
  constructor(errorClass: "base_not_found" | "paragraph_count_mismatch") {
    super(errorClass);
    this.name = "CoverLetterEditError";
    this.errorClass = errorClass;
  }
}

/**
 * Saves the user's wording as a new user_edited version (Phase 7c design §3; same rules as
 * createEditedPitch, D77): roles, evidence and research snapshot are copied from the base, supported /
 * unsupportedReason and missingTermMentions (D106) become null and requiresReview = false -- the user is
 * the authority on their own wording. The body must have exactly as many paragraphs as the base.
 */
export async function createEditedCoverLetter(db: DbClient, userId: string, jobId: string, body: EditCoverLetterBody): Promise<CoverLetterRow> {
  return withUserContext(db, userId, async (tx) => {
    const [base] = await tx
      .select()
      .from(coverLetters)
      .where(and(eq(coverLetters.id, body.baseVersionId), eq(coverLetters.jobId, jobId)))
      .limit(1);
    if (!base) throw new CoverLetterEditError("base_not_found");

    // The count check needs the base row, so it runs after the lookup: a body that could never match
    // (e.g. four paragraphs against a five-paragraph base) still costs one indexed read, which is fine.
    const baseParagraphs = base.paragraphs as StoredCoverLetterParagraph[];
    if (baseParagraphs.length !== body.paragraphs.length) throw new CoverLetterEditError("paragraph_count_mismatch");

    const paragraphs: StoredCoverLetterParagraph[] = baseParagraphs.map((p, i) => ({
      role: p.role,
      text: body.paragraphs[i],
      supported: null,
      unsupportedReason: null,
      evidence: p.evidence,
      missingTermMentions: null,
    }));

    return insertCoverLetterVersion(tx, userId, jobId, {
      origin: "user_edited",
      parentCoverLetterId: base.id,
      companyResearchId: base.companyResearchId,
      researchStatusSnapshot: base.researchStatusSnapshot,
      researchedAtSnapshot: base.researchedAtSnapshot,
      paragraphs,
      requiresReview: false,
      sourceProfileContentHash: null,
      generationModel: null,
    });
  });
}
