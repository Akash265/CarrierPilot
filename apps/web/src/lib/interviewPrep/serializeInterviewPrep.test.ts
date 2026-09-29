import { describe, it, expect } from "vitest";
import type { InterviewPrepRow } from "@ai-career/application-package";
import { toInterviewPrepView } from "./serializeInterviewPrep";

const bad = { id: "r:1", kind: "research", text: "e", sourceUrl: "javascript:alert(1)" };
const row = {
  id: "i1", userId: "u", jobId: "j", version: 3, companyResearchId: null, researchStatusSnapshot: "failed", researchedAtSnapshot: null,
  requiresReview: true, sourceProfileContentHash: "h", generationModel: "m", createdAt: new Date("2026-09-29T01:00:00Z"),
  gapTermsSnapshot: ["Kubernetes"],
  sections: {
    likelyQuestions: [{ question: "Q?", category: "role", answerOutline: ["A"], supported: true, unsupportedReason: null, evidence: [bad] }],
    gapQuestions: [], talkingPoints: [{ text: "T", supported: false, unsupportedReason: "cites no company research", evidence: [] }],
    questionsToAsk: [],
  },
} as unknown as InterviewPrepRow;

describe("toInterviewPrepView", () => {
  it("serializes sections, gap terms and dates, nulling non-http URLs", () => {
    const view = toInterviewPrepView(row);
    expect(view).toMatchObject({ id: "i1", version: 3, gapTerms: ["Kubernetes"], requiresReview: true, researchStatus: "failed", researchedAt: null });
    expect(view.sections.likelyQuestions[0].evidence[0].sourceUrl).toBeNull();
    expect(view.sections.talkingPoints[0]).toMatchObject({ supported: false, unsupportedReason: "cites no company research" });
  });
});
