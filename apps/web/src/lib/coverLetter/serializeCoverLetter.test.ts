import { describe, it, expect } from "vitest";
import type { CoverLetterRow } from "@ai-career/application-package";
import { toCoverLetterView } from "./serializeCoverLetter";

const row = {
  id: "c1", userId: "u", jobId: "j", version: 2, origin: "generated", parentCoverLetterId: null, companyResearchId: "r",
  researchStatusSnapshot: "ok", researchedAtSnapshot: new Date("2026-09-29T00:00:00Z"), requiresReview: false,
  sourceProfileContentHash: "h", generationModel: "m", createdAt: new Date("2026-09-29T01:00:00Z"),
  paragraphs: [{ role: "company", text: "T", supported: true, unsupportedReason: null,
    evidence: [{ id: "r:1", kind: "research", text: "e", sourceUrl: "javascript:alert(1)" }, { id: "r:2", kind: "research", text: "f", sourceUrl: "https://ok.example" }] }],
} as unknown as CoverLetterRow;

describe("toCoverLetterView", () => {
  it("serializes dates and nulls non-http evidence URLs", () => {
    const view = toCoverLetterView(row);
    expect(view).toMatchObject({ id: "c1", version: 2, origin: "generated", researchStatus: "ok", researchedAt: "2026-09-29T00:00:00.000Z", createdAt: "2026-09-29T01:00:00.000Z" });
    expect(view.paragraphs[0].evidence.map((e) => e.sourceUrl)).toEqual([null, "https://ok.example"]);
  });

  it("exposes missingTermMentions and reads a pre-D106 paragraph without the field as null", () => {
    const base = (row as unknown as { paragraphs: object[] }).paragraphs[0];
    const withField = { ...row, paragraphs: [{ ...base, missingTermMentions: ["Kubernetes"] }, { ...base, missingTermMentions: [] }, { ...base, missingTermMentions: null }, base] } as unknown as CoverLetterRow;
    expect(toCoverLetterView(withField).paragraphs.map((p) => p.missingTermMentions)).toEqual([["Kubernetes"], [], null, null]);
  });
});
