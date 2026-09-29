import { describe, it, expect } from "vitest";
import { applyInterviewPrepGuard } from "./applyInterviewPrepGuard";
import type { PitchEvidenceItem } from "../pitch/buildEvidenceIndex";
import type { InterviewPrepDraft } from "./interviewPrepSchema";

const EVIDENCE: PitchEvidenceItem[] = [
  { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
  { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
  { id: "q:q2", kind: "requirement", text: "[required] Kubernetes", sourceUrl: null },
  { id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null },
  { id: "p:k8s", kind: "profile", text: "Ran kubernetes clusters", sourceUrl: null },
];
const GAPS = [{ term: "Kubernetes", requirementId: "q2" }];
const likely = (evidenceIds = ["q:q1", "p:b1"]) => ({ question: "Q?", category: "technical" as const, answerOutline: ["A"], evidenceIds });
const gap = (requirementTerm: string, evidenceIds: string[]) => ({ question: "G?", requirementTerm, framing: "F.", evidenceIds });
const base = (): InterviewPrepDraft => ({
  likelyQuestions: [likely(), likely(), likely(), likely(), likely()],
  gapQuestions: [gap("Kubernetes", ["q:q2"])],
  talkingPoints: [1, 2, 3].map(() => ({ text: "T", evidenceIds: ["r:f1"] })),
  questionsToAsk: [1, 2, 3].map(() => ({ question: "A?", evidenceIds: ["q:q1"] })),
  requiresReview: false,
});

describe("applyInterviewPrepGuard", () => {
  it("supports a fully grounded pack and snapshots evidence", () => {
    const r = applyInterviewPrepGuard(EVIDENCE, GAPS, base());
    expect(r.requiresReview).toBe(false);
    const all = [...r.sections.likelyQuestions, ...r.sections.gapQuestions, ...r.sections.talkingPoints, ...r.sections.questionsToAsk];
    expect(all.every((i) => i.supported)).toBe(true);
    expect(r.sections.talkingPoints[0].evidence[0].text).toBe("Acme builds rockets.");
    expect(r.sections.likelyQuestions[0]).toMatchObject({ question: "Q?", category: "technical", answerOutline: ["A"] });
  });

  it("requires a likely question to cite both a requirement and profile evidence", () => {
    const d = base();
    d.likelyQuestions[0] = likely(["q:q1"]);
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.likelyQuestions[0].unsupportedReason).toBe("cites no profile evidence");
  });

  it("requires talking points to cite research and questions-to-ask to cite research or a requirement", () => {
    const d = base();
    d.talkingPoints[0] = { text: "T", evidenceIds: ["q:q1"] };
    d.questionsToAsk[0] = { question: "A?", evidenceIds: ["p:b1"] };
    const r = applyInterviewPrepGuard(EVIDENCE, GAPS, d);
    expect(r.sections.talkingPoints[0].unsupportedReason).toBe("cites no company research");
    expect(r.sections.questionsToAsk[0].unsupportedReason).toBe("cites no company research or job requirement");
  });

  it("flags a gap question for a term that is not a computed gap", () => {
    const d = base();
    d.gapQuestions = [gap("SQL", ["q:q1"])];
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.gapQuestions[0].unsupportedReason).toBe('requirementTerm "SQL" is not one of the missing required terms');
  });

  it("flags a second gap question for the same term (case-insensitive)", () => {
    const d = base();
    d.gapQuestions = [gap("Kubernetes", ["q:q2"]), gap(" kubernetes ", ["q:q2"])];
    const r = applyInterviewPrepGuard(EVIDENCE, GAPS, d);
    expect(r.sections.gapQuestions[0].supported).toBe(true);
    expect(r.sections.gapQuestions[1].unsupportedReason).toBe('requirementTerm " kubernetes " already has a gap question');
  });

  it("flags a gap question that does not cite its own requirement id", () => {
    const d = base();
    d.gapQuestions = [gap("Kubernetes", ["q:q1"])];
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.gapQuestions[0].unsupportedReason).toBe("does not cite the requirement it probes");
  });

  it("flags a gap framing that cites profile evidence containing the missing term", () => {
    const d = base();
    d.gapQuestions = [gap("Kubernetes", ["q:q2", "p:k8s"])];
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.gapQuestions[0].unsupportedReason).toBe('cites profile evidence that contains the missing term "Kubernetes"');
  });

  it("sets requiresReview on any unsupported item or on the model's own flag", () => {
    const d = base();
    d.talkingPoints[1] = { text: "T", evidenceIds: [] };
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).requiresReview).toBe(true);
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, { ...base(), requiresReview: true }).requiresReview).toBe(true);
  });
});
