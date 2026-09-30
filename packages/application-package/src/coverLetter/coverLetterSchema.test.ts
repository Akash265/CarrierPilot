import { describe, it, expect } from "vitest";
import { CoverLetterDraftSchema, isValidParagraphOrder } from "./coverLetterSchema";

const p = (role: string, text = "Text.") => ({ role, text, evidenceIds: [] });

describe("isValidParagraphOrder", () => {
  it("accepts 4 or 5 paragraphs in the fixed order", () => {
    expect(isValidParagraphOrder(["opening", "company", "evidence", "closing"])).toBe(true);
    expect(isValidParagraphOrder(["opening", "company", "evidence", "evidence", "closing"])).toBe(true);
  });
  it("rejects wrong counts and orders", () => {
    expect(isValidParagraphOrder(["opening", "company", "closing"])).toBe(false);
    expect(isValidParagraphOrder(["opening", "company", "evidence", "evidence", "evidence", "closing"])).toBe(false);
    expect(isValidParagraphOrder(["company", "opening", "evidence", "closing"])).toBe(false);
    expect(isValidParagraphOrder(["opening", "company", "closing", "evidence"])).toBe(false);
  });
});

describe("CoverLetterDraftSchema", () => {
  it("parses a valid draft and trims text", () => {
    const r = CoverLetterDraftSchema.parse({ paragraphs: [p("opening", "  Hi.  "), p("company"), p("evidence"), p("closing")], requiresReview: false });
    expect(r.paragraphs[0].text).toBe("Hi.");
  });
  it("rejects a bad order, an empty paragraph and an over-long paragraph", () => {
    expect(CoverLetterDraftSchema.safeParse({ paragraphs: [p("company"), p("opening"), p("evidence"), p("closing")], requiresReview: false }).success).toBe(false);
    expect(CoverLetterDraftSchema.safeParse({ paragraphs: [p("opening", " "), p("company"), p("evidence"), p("closing")], requiresReview: false }).success).toBe(false);
    expect(CoverLetterDraftSchema.safeParse({ paragraphs: [p("opening", "x".repeat(1201)), p("company"), p("evidence"), p("closing")], requiresReview: false }).success).toBe(false);
  });
});
