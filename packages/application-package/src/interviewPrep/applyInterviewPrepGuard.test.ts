import { describe, it, expect } from "vitest";
import { applyInterviewPrepGuard } from "./applyInterviewPrepGuard";
import type { PitchEvidenceItem } from "../pitch/buildEvidenceIndex";
import type { InterviewPrepDraft } from "./interviewPrepSchema";
import type { GapTerm } from "../types";

const EVIDENCE: PitchEvidenceItem[] = [
  { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
  { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
  { id: "q:q2", kind: "requirement", text: "[required] Kubernetes", sourceUrl: null },
  { id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null },
  { id: "p:k8s", kind: "profile", text: "Ran kubernetes clusters", sourceUrl: null },
];
const K8S_GAP: GapTerm = { term: "Kubernetes", requirementId: "q2" };
const both = (list: GapTerm[]) => ({ modelGapTerms: list, allGapTerms: list });
const GAPS = both([K8S_GAP]);
const likely = (evidenceIds = ["q:q1", "p:b1"], category: "technical" | "behavioral" | "role" = "technical") => ({
  question: "Q?",
  category,
  answerOutline: ["A"],
  evidenceIds,
});
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

  it("supports a role likely question that cites research and profile evidence (no requirement id)", () => {
    const d = base();
    d.likelyQuestions[0] = likely(["r:f1", "p:b1"], "role");
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.likelyQuestions[0].supported).toBe(true);
  });

  it("flags a role likely question that cites only profile evidence", () => {
    const d = base();
    d.likelyQuestions[0] = likely(["p:b1"], "role");
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.likelyQuestions[0].unsupportedReason).toBe(
      "cites no company research or job requirement"
    );
  });

  it("still requires a technical likely question to cite a job requirement even when it cites research", () => {
    const d = base();
    d.likelyQuestions[0] = likely(["r:f1", "p:b1"], "technical");
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.likelyQuestions[0].unsupportedReason).toBe(
      "cites no job requirement"
    );
  });

  it("flags a likely question that cites the gap term's own requirement id", () => {
    const d = base();
    d.likelyQuestions[0] = likely(["q:q2", "p:b1"]);
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.likelyQuestions[0].unsupportedReason).toBe(
      'targets a missing required term "Kubernetes"; use a gap question'
    );
  });

  it("flags a likely question whose answer outline mentions a gap term in a different case", () => {
    const d = base();
    d.likelyQuestions[0] = { question: "Q?", category: "technical", answerOutline: ["Discuss KUBERNETES experience"], evidenceIds: ["q:q1", "p:b1"] };
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.likelyQuestions[0].unsupportedReason).toBe(
      'targets a missing required term "Kubernetes"; use a gap question'
    );
  });

  it("does not restrict talking points or questions-to-ask from citing a gap term's requirement id", () => {
    const d = base();
    d.questionsToAsk[0] = { question: "A?", evidenceIds: ["q:q2"] };
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.questionsToAsk[0].supported).toBe(true);
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

  it("stores the canonical gap term as requirementTerm when matched, but keeps the model's spelling for an unmatched or duplicate-blocked term", () => {
    const d = base();
    d.gapQuestions = [gap("KUBERNETES", ["q:q2"]), gap(" kubernetes ", ["q:q2"]), gap("SQL", ["q:q1"])];
    const r = applyInterviewPrepGuard(EVIDENCE, GAPS, d);
    expect(r.sections.gapQuestions[0].requirementTerm).toBe("Kubernetes");
    expect(r.sections.gapQuestions[1].requirementTerm).toBe(" kubernetes ");
    expect(r.sections.gapQuestions[2].requirementTerm).toBe("SQL");
  });

  it("does not reserve a gap term when the first question for it fails to cite its own requirement (first-use-wins on success)", () => {
    const d = base();
    d.gapQuestions = [gap("Kubernetes", ["q:q1"]), gap("Kubernetes", ["q:q2"])];
    const r = applyInterviewPrepGuard(EVIDENCE, GAPS, d);
    expect(r.sections.gapQuestions[0].unsupportedReason).toBe("does not cite the requirement it probes");
    expect(r.sections.gapQuestions[1].supported).toBe(true);
  });

  it("flags every gap question when there are no computed gap terms", () => {
    const d = base();
    d.gapQuestions = [gap("Kubernetes", ["q:q2"])];
    expect(applyInterviewPrepGuard(EVIDENCE, both([]), d).sections.gapQuestions[0].unsupportedReason).toBe('requirementTerm "Kubernetes" is not one of the missing required terms');
  });

  it("flags a gap question that cites only another gap's requirement id", () => {
    const evidence = [...EVIDENCE, { id: "q:q3", kind: "requirement" as const, text: "[required] Terraform", sourceUrl: null }];
    const gaps = both([K8S_GAP, { term: "Terraform", requirementId: "q3" }]);
    const d = base();
    d.gapQuestions = [gap("Kubernetes", ["q:q3"])];
    expect(applyInterviewPrepGuard(evidence, gaps, d).sections.gapQuestions[0].unsupportedReason).toBe("does not cite the requirement it probes");
  });

  it("flags a gap question citing a non-existent evidence id", () => {
    const d = base();
    d.gapQuestions = [gap("Kubernetes", ["q:nonexistent"])];
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).sections.gapQuestions[0].unsupportedReason).toContain('evidence id "q:nonexistent" does not exist');
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

  describe("with more gap terms than the model was given (I1)", () => {
    // Seven missing required terms; only the first five (MAX_GAP_TERMS) went to the model.
    const SEVEN = ["T1", "T2", "T3", "T4", "T5", "T6", "Terraform"].map((term, i) => ({ term, requirementId: `g${i + 1}` }));
    const evidence = [...EVIDENCE, ...SEVEN.map((g) => ({ id: `q:${g.requirementId}`, kind: "requirement" as const, text: `[required] ${g.term}`, sourceUrl: null }))];
    const gaps = { modelGapTerms: SEVEN.slice(0, 5), allGapTerms: SEVEN };

    it("flags a likely question that targets the 7th gap term by text", () => {
      const d = base();
      d.gapQuestions = [];
      d.likelyQuestions[0] = { question: "How do you use Terraform?", category: "technical", answerOutline: ["A"], evidenceIds: ["q:q1", "p:b1"] };
      expect(applyInterviewPrepGuard(evidence, gaps, d).sections.likelyQuestions[0].unsupportedReason).toBe(
        'targets a missing required term "Terraform"; use a gap question'
      );
    });

    it("flags a likely question that cites the 7th gap term's requirement id", () => {
      const d = base();
      d.gapQuestions = [];
      d.likelyQuestions[0] = likely(["q:g7", "p:b1"]);
      expect(applyInterviewPrepGuard(evidence, gaps, d).sections.likelyQuestions[0].unsupportedReason).toBe(
        'targets a missing required term "Terraform"; use a gap question'
      );
    });

    it("flags a gap question for the 7th term (not given to the model) as not one of the missing required terms", () => {
      const d = base();
      d.gapQuestions = [gap("Terraform", ["q:g7"]), gap("T1", ["q:g1"])];
      const r = applyInterviewPrepGuard(evidence, gaps, d);
      expect(r.sections.gapQuestions[0].unsupportedReason).toBe('requirementTerm "Terraform" is not one of the missing required terms');
      expect(r.sections.gapQuestions[1].supported).toBe(true);
    });
  });

  it("sets requiresReview on any unsupported item or on the model's own flag", () => {
    const d = base();
    d.talkingPoints[1] = { text: "T", evidenceIds: [] };
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, d).requiresReview).toBe(true);
    expect(applyInterviewPrepGuard(EVIDENCE, GAPS, { ...base(), requiresReview: true }).requiresReview).toBe(true);
  });
});
