import { z } from "zod";
import {
  LIKELY_QUESTION_CATEGORIES, MAX_FRAMING_CHARS, MAX_OUTLINE_LINE_CHARS, MAX_POINT_CHARS, MAX_QUESTION_CHARS, MAX_GAP_TERMS,
  MAX_REQUIREMENT_TERM_CHARS,
} from "../types";

const text = (max: number) => z.string().trim().min(1).max(max);
const evidenceIds = z.array(z.string().min(1));

// D110: with sparse evidence, fewer honest items are better than a failed pack (a 502) or a model that
// pads/fabricates items to hit a minimum. The prompt still asks for the planned ranges (likelyQuestions
// 5-8, talkingPoints 3-6, questionsToAsk 3-5) and tells the model to return fewer rather than invent, but
// the schema itself only floors each section at 1 item (gapQuestions stays 0..MAX_GAP_TERMS, unchanged).
// When the model returns MORE than the planned max, that is not an error either: `capped` keeps the
// first N items (in order) via a `.transform`, which Zod always runs after the array's own `.min()`
// check, so a too-short array still fails validation while a too-long one is silently trimmed.
const capped = <T extends z.ZodTypeAny>(schema: z.ZodArray<T>, max: number) => schema.transform((items) => items.slice(0, max));

export const InterviewPrepDraftSchema = z.object({
  likelyQuestions: capped(
    z
      .array(z.object({
        question: text(MAX_QUESTION_CHARS),
        category: z.enum(LIKELY_QUESTION_CATEGORIES),
        answerOutline: capped(z.array(text(MAX_OUTLINE_LINE_CHARS)).min(1), 5),
        evidenceIds,
      }))
      .min(1),
    8
  ),
  // Trimmed at 2x MAX_GAP_TERMS, not MAX_GAP_TERMS: the guard (applyInterviewPrepGuard), not this schema,
  // is what limits a gap question to one per valid term -- an early duplicate or off-list gap question is
  // flagged as an extra there, not rejected here. Trimming to the model's own planned count (MAX_GAP_TERMS)
  // could silently drop a later, valid gap question past that point; doubling the room before the schema
  // itself trims makes that far less likely while still bounding the array.
  gapQuestions: capped(
    z.array(z.object({ question: text(MAX_QUESTION_CHARS), requirementTerm: text(MAX_REQUIREMENT_TERM_CHARS), framing: text(MAX_FRAMING_CHARS), evidenceIds })),
    MAX_GAP_TERMS * 2
  ),
  talkingPoints: capped(z.array(z.object({ text: text(MAX_POINT_CHARS), evidenceIds })).min(1), 6),
  questionsToAsk: capped(z.array(z.object({ question: text(MAX_POINT_CHARS), evidenceIds })).min(1), 5),
  requiresReview: z.boolean(),
});

export type InterviewPrepDraft = z.infer<typeof InterviewPrepDraftSchema>;
