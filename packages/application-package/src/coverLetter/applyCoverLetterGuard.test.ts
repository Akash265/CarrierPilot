import { describe, it, expect } from "vitest";
import { applyCoverLetterGuard } from "./applyCoverLetterGuard";
import type { PitchEvidenceItem } from "../pitch/buildEvidenceIndex";
import type { CoverLetterDraft } from "./coverLetterSchema";

const EVIDENCE: PitchEvidenceItem[] = [
  { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
  { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
  { id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null },
];
const draft = (ids: string[][], requiresReview = false): CoverLetterDraft => {
  const roles = ids.length === 5 ? ["opening", "company", "evidence", "evidence", "closing"] : ["opening", "company", "evidence", "closing"];
  return { paragraphs: ids.map((evidenceIds, i) => ({ role: roles[i] as never, text: `P${i}`, evidenceIds })), requiresReview };
};

describe("applyCoverLetterGuard", () => {
  it("supports every paragraph citing its required kind; closing needs none", () => {
    const r = applyCoverLetterGuard(EVIDENCE, draft([["q:q1"], ["r:f1"], ["p:b1"], []]));
    expect(r.paragraphs.map((p) => [p.role, p.supported])).toEqual([["opening", true], ["company", true], ["evidence", true], ["closing", true]]);
    expect(r.requiresReview).toBe(false);
    expect(r.paragraphs[1].evidence[0]).toEqual({ id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" });
  });

  it("flags each paragraph missing its required kind, and every evidence paragraph independently", () => {
    const r = applyCoverLetterGuard(EVIDENCE, draft([["p:b1"], ["q:q1"], ["p:b1"], ["r:f1"], []]));
    expect(r.paragraphs[0].unsupportedReason).toBe("cites no job requirement");
    expect(r.paragraphs[1].unsupportedReason).toBe("cites no company research");
    expect(r.paragraphs[2].supported).toBe(true);
    expect(r.paragraphs[3].unsupportedReason).toBe("cites no profile evidence");
    expect(r.requiresReview).toBe(true);
  });

  it("still validates ids cited by the closing", () => {
    const r = applyCoverLetterGuard(EVIDENCE, draft([["q:q1"], ["r:f1"], ["p:b1"], ["p:ghost"]]));
    expect(r.paragraphs[3]).toMatchObject({ supported: false, unsupportedReason: 'evidence id "p:ghost" does not exist' });
  });

  it("ORs in the model's own requiresReview", () => {
    expect(applyCoverLetterGuard(EVIDENCE, draft([["q:q1"], ["r:f1"], ["p:b1"], []], true)).requiresReview).toBe(true);
  });
});
