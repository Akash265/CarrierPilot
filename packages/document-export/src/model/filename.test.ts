import { describe, it, expect } from "vitest";
import { sanitizeFilename, buildDownloadFilename } from "./filename";

describe("sanitizeFilename", () => {
  it("strips diacritics and unsafe characters and appends the extension", () => {
    expect(sanitizeFilename('José Núñez / "Acme" <GmbH>', "pdf")).toBe("Jose Nunez Acme GmbH.pdf");
  });

  it("removes control characters and collapses whitespace", () => {
    expect(sanitizeFilename("a\u0000\nb\t  c", "docx")).toBe("a b c.docx");
  });

  it("caps the base at 120 characters", () => {
    expect(sanitizeFilename("x".repeat(300), "pdf")).toBe("x".repeat(120) + ".pdf");
  });

  it("falls back to 'document' when nothing safe remains", () => {
    expect(sanitizeFilename("/// ***", "pdf")).toBe("document.pdf");
  });
});

describe("buildDownloadFilename", () => {
  it("formats name - company - kind", () => {
    expect(buildDownloadFilename("Jane Doe", "GitLab", "resume", "pdf")).toBe("Jane Doe - GitLab - Resume.pdf");
    expect(buildDownloadFilename("Jane Doe", "GitLab", "pitch", "docx")).toBe("Jane Doe - GitLab - Pitch.docx");
  });

  // Fix round 2 (second review): sanitizeFilename's 120-char cap applied to the whole "name - company -
  // kind" string could truncate before reaching the " - Resume"/" - Pitch" suffix, so a long company name
  // made the resume and pitch downloads for the same job collide on one filename.

  it("caps the name and company parts independently (50 chars each) so a long value can never crowd out the other part or the kind suffix", () => {
    const longCompany = "x".repeat(300);
    const filename = buildDownloadFilename("Jane Doe", longCompany, "resume", "pdf");
    expect(filename).toBe(`Jane Doe - ${"x".repeat(50)} - Resume.pdf`);
  });

  it("keeps Resume and Pitch filenames distinct even when the company name is very long", () => {
    const longCompany = "x".repeat(300);
    const resume = buildDownloadFilename("Jane Doe", longCompany, "resume", "pdf");
    const pitch = buildDownloadFilename("Jane Doe", longCompany, "pitch", "pdf");
    expect(resume).not.toBe(pitch);
    expect(resume.endsWith(" - Resume.pdf")).toBe(true);
    expect(pitch.endsWith(" - Pitch.pdf")).toBe(true);
  });
});
