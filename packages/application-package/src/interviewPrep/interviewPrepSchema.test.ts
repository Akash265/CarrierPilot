import { describe, it, expect } from "vitest";
import { InterviewPrepDraftSchema } from "./interviewPrepSchema";

const likely = (i: number) => ({ question: `Q${i}?`, category: "technical", answerOutline: ["Point"], evidenceIds: [] });
const point = (i: number) => ({ text: `T${i}`, evidenceIds: [] });
const ask = (i: number) => ({ question: `A${i}?`, evidenceIds: [] });
const gapQ = (i: number) => ({ question: `G${i}?`, requirementTerm: `Term${i}`, framing: "Honest framing.", evidenceIds: [] });
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

  // D110: sparse evidence should produce fewer honest items, not a failed pack.
  it("accepts the minimum of 1 item for likelyQuestions, talkingPoints and questionsToAsk", () => {
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), likelyQuestions: [likely(1)] }).success).toBe(true);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), talkingPoints: [point(1)] }).success).toBe(true);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), questionsToAsk: [ask(1)] }).success).toBe(true);
  });

  it("still rejects zero items for likelyQuestions, talkingPoints and questionsToAsk", () => {
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), likelyQuestions: [] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), talkingPoints: [] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...valid(), questionsToAsk: [] }).success).toBe(false);
  });

  // D110: an over-long array is not an error -- the first N items are kept, in order.
  it("keeps only the first N items in order when a section exceeds its planned max", () => {
    const tenLikely = Array.from({ length: 10 }, (_, i) => likely(i + 1));
    const likelyResult = InterviewPrepDraftSchema.safeParse({ ...valid(), likelyQuestions: tenLikely });
    expect(likelyResult.success).toBe(true);
    if (likelyResult.success) {
      expect(likelyResult.data.likelyQuestions).toHaveLength(8);
      expect(likelyResult.data.likelyQuestions.map((q) => q.question)).toEqual(tenLikely.slice(0, 8).map((q) => q.question));
    }

    const nineTalking = Array.from({ length: 9 }, (_, i) => point(i + 1));
    const talkingResult = InterviewPrepDraftSchema.safeParse({ ...valid(), talkingPoints: nineTalking });
    expect(talkingResult.success).toBe(true);
    if (talkingResult.success) {
      expect(talkingResult.data.talkingPoints).toHaveLength(6);
      expect(talkingResult.data.talkingPoints.map((p) => p.text)).toEqual(nineTalking.slice(0, 6).map((p) => p.text));
    }

    const sevenAsk = Array.from({ length: 7 }, (_, i) => ask(i + 1));
    const askResult = InterviewPrepDraftSchema.safeParse({ ...valid(), questionsToAsk: sevenAsk });
    expect(askResult.success).toBe(true);
    if (askResult.success) {
      expect(askResult.data.questionsToAsk).toHaveLength(5);
      expect(askResult.data.questionsToAsk.map((q) => q.question)).toEqual(sevenAsk.slice(0, 5).map((q) => q.question));
    }

    const sevenGap = Array.from({ length: 7 }, (_, i) => gapQ(i + 1));
    const gapResult = InterviewPrepDraftSchema.safeParse({ ...valid(), gapQuestions: sevenGap });
    expect(gapResult.success).toBe(true);
    if (gapResult.success) {
      expect(gapResult.data.gapQuestions).toHaveLength(5);
      expect(gapResult.data.gapQuestions.map((q) => q.requirementTerm)).toEqual(sevenGap.slice(0, 5).map((q) => q.requirementTerm));
    }
  });

  it("keeps only the first 5 answer-outline lines when a likely question returns more", () => {
    const sevenLines = Array.from({ length: 7 }, (_, i) => `Line ${i + 1}`);
    const result = InterviewPrepDraftSchema.safeParse({ ...valid(), likelyQuestions: [{ ...likely(1), answerOutline: sevenLines }] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.likelyQuestions[0].answerOutline).toEqual(sevenLines.slice(0, 5));
  });

  it("enforces text caps and rejects an empty answer-outline", () => {
    const v = valid();
    expect(InterviewPrepDraftSchema.safeParse({ ...v, likelyQuestions: [{ ...likely(1), question: "x".repeat(301) }, ...v.likelyQuestions.slice(1)] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...v, likelyQuestions: [{ ...likely(1), answerOutline: [] }, ...v.likelyQuestions.slice(1)] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...v, gapQuestions: [{ ...v.gapQuestions[0], framing: "x".repeat(801) }] }).success).toBe(false);
    expect(InterviewPrepDraftSchema.safeParse({ ...v, talkingPoints: [{ text: "x".repeat(401), evidenceIds: [] }, point(2), point(3)] }).success).toBe(false);
  });
});
