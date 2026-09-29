import { describe, it, expect } from "vitest";
import { InterviewPrepDraftSchema } from "./interviewPrepSchema";

const likely = (i: number) => ({ question: `Q${i}?`, category: "technical", answerOutline: ["Point"], evidenceIds: [] });
const point = (i: number) => ({ text: `T${i}`, evidenceIds: [] });
const ask = (i: number) => ({ question: `A${i}?`, evidenceIds: [] });
const valid = () => ({
  likelyQuestions: [1, 2, 3, 4, 5].map(likely),
  gapQuestions: [{ question: "G?", requirementTerm: "Rust", framing: "Honest framing.", evidenceIds: [] }],
  talkingPoints: [1, 2, 3].map(point),
  questionsToAsk: [1, 2, 3].map(ask),
  requiresReview: false,
});

describe("InterviewPrepDraftSchema", () => {
  it("accepts a valid draft and an empty gap list", () => {
    expect(InterviewPrepDraftSchema.safeParse(valid()).success).toBe(true);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), gapQuestions: [] }).success).toBe(true);
  });

  it("enforces the section counts", () => {
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), likelyQuestions: [1, 2, 3, 4].map(likely) }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), likelyQuestions: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(likely) }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), gapQuestions: Array(6).fill(valid().gapQuestions[0]) }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), talkingPoints: [1, 2].map(point) }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), questionsToAsk: [1, 2, 3, 4, 5, 6].map(ask) }).success).toBe(false);
  });

  it("enforces text caps and 1-5 answer-outline lines", () => {
    const v = valid();
    expect(InterviewPrepDraftSchema.safeParse({ ...v, likelyQuestions: [{ ...likely(1), question: "x".repeat(301) }, ...v.likelyQuestions.slice(1)] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...v, likelyQuestions: [{ ...likely(1), answerOutline: [] }, ...v.likelyQuestions.slice(1)] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...v, likelyQuestions: [{ ...likely(1), answerOutline: Array(6).fill("p") }, ...v.likelyQuestions.slice(1)] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...v, gapQuestions: [{ ...v.gapQuestions[0], framing: "x".repeat(801) }] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...v, talkingPoints: [{ text: "x".repeat(401), evidenceIds: [] }, point(2), point(3)] }).success).toBe(false);
  });
});
