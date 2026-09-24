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
});
