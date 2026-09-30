import { z } from "zod";
import { COVER_LETTER_ROLES, MAX_PARAGRAPH_CHARS, type CoverLetterRole } from "../types";

/** opening, company, 1-2 × evidence, closing (design §3). */
export function isValidParagraphOrder(roles: CoverLetterRole[]): boolean {
  const n = roles.length;
  if (n !== 4 && n !== 5) return false;
  return roles[0] === "opening" && roles[1] === "company" && roles[n - 1] === "closing" && roles.slice(2, n - 1).every((r) => r === "evidence");
}

export const CoverLetterDraftParagraphSchema = z.object({
  role: z.enum(COVER_LETTER_ROLES),
  text: z.string().trim().min(1).max(MAX_PARAGRAPH_CHARS),
  evidenceIds: z.array(z.string().min(1)),
});

export const CoverLetterDraftSchema = z.object({
  paragraphs: z
    .array(CoverLetterDraftParagraphSchema)
    .min(4)
    .max(5)
    .refine((ps) => isValidParagraphOrder(ps.map((p) => p.role)), {
      message: "paragraphs must be ordered opening, company, evidence (1-2), closing",
    }),
  requiresReview: z.boolean(),
});

export type CoverLetterDraft = z.infer<typeof CoverLetterDraftSchema>;
