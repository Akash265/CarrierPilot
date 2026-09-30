import { describe, it, expect } from "vitest";
import type { StoredCoverLetterParagraph } from "@ai-career/application-package";
import { buildCoverLetterModel } from "./buildCoverLetterModel";

const p = (role: StoredCoverLetterParagraph["role"], text: string): StoredCoverLetterParagraph =>
  ({ role, text, supported: true, unsupportedReason: null, evidence: [] });

describe("buildCoverLetterModel", () => {
  it("builds name, contact line, salutation, the paragraphs in order and a sign-off", () => {
    const model = buildCoverLetterModel(
      { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: null, linkedinUrl: null },
      { title: "Backend Engineer", companyName: "GitLab" },
      [p("opening", "Open."), p("company", "Company."), p("evidence", "Proof."), p("closing", "Close.")]
    );
    expect(model).toEqual({
      title: "Application for Backend Engineer at GitLab",
      contactLine: null,
      blocks: [
        { type: "paragraph", text: "Jane Doe" },
        { type: "paragraph", text: "jane@example.com" },
        { type: "paragraph", text: "Dear Hiring Manager," },
        { type: "paragraph", text: "Open." },
        { type: "paragraph", text: "Company." },
        { type: "paragraph", text: "Proof." },
        { type: "paragraph", text: "Close." },
        { type: "paragraph", text: "Sincerely," },
        { type: "paragraph", text: "Jane Doe" },
      ],
    });
  });

  it("omits the contact line when there is none", () => {
    const model = buildCoverLetterModel({ fullName: "Jane Doe", email: "", phoneNumber: null, linkedinUrl: null }, { title: "T", companyName: "C" },
      [p("opening", "O."), p("company", "C."), p("evidence", "E."), p("closing", "X.")]);
    expect(model.blocks[1]).toEqual({ type: "paragraph", text: "Dear Hiring Manager," });
  });
});
