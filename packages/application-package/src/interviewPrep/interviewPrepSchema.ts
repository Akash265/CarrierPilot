import { z } from "zod";
import {
  LIKELY_QUESTION_CATEGORIES, MAX_FRAMING_CHARS, MAX_OUTLINE_LINE_CHARS, MAX_POINT_CHARS, MAX_QUESTION_CHARS, MAX_GAP_TERMS,
  MAX_REQUIREMENT_TERM_CHARS,
} from "../types";

const text = (max: number) => z.string().trim().min(1).max(max);
const evidenceIds = z.array(z.string().min(1));

export const InterviewPrepDraftSchema = z.object({
  likelyQuestions: z
    .array(z.object({
      question: text(MAX_QUESTION_CHARS),
      category: z.enum(LIKELY_QUESTION_CATEGORIES),
      answerOutline: z.array(text(MAX_OUTLINE_LINE_CHARS)).min(1).max(5),
      evidenceIds,
    }))
    .min(5)
    .max(8),
  gapQuestions: z
    .array(z.object({ question: text(MAX_QUESTION_CHARS), requirementTerm: text(MAX_REQUIREMENT_TERM_CHARS), framing: text(MAX_FRAMING_CHARS), evidenceIds }))
    .max(MAX_GAP_TERMS),
  talkingPoints: z.array(z.object({ text: text(MAX_POINT_CHARS), evidenceIds })).min(3).max(6),
  questionsToAsk: z.array(z.object({ question: text(MAX_POINT_CHARS), evidenceIds })).min(3).max(5),
  requiresReview: z.boolean(),
});

export type InterviewPrepDraft = z.infer<typeof InterviewPrepDraftSchema>;
