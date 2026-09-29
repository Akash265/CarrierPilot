import { describe, it, expect } from "vitest";
import type { EvidenceCatalogEntry } from "@ai-career/resume-optimization";
import { computeGapTerms } from "./computeGapTerms";

const req = (id: string, termText: string, requirementLevel: "required" | "preferred" = "required") => ({ id, termText, requirementLevel });
const entry = (text: string, context: string | null = null): EvidenceCatalogEntry =>
  ({ sourceFactId: text, sourceType: "work_experience_bullet", text, context }) as EvidenceCatalogEntry;

describe("computeGapTerms", () => {
  it("returns required terms not contained (case-insensitively) in any profile evidence text or context", () => {
    const gaps = computeGapTerms(
      [req("1", "SQL"), req("2", "Kubernetes"), req("3", "Globex"), req("4", "Terraform", "preferred")],
      [entry("Built a sql pipeline"), entry("Led migrations", "Globex — Engineer")]
    );
    expect(gaps).toEqual([{ term: "Kubernetes", requirementId: "2" }]);
  });

  it("ignores blank terms, de-duplicates case-insensitively and orders by term then id", () => {
    const gaps = computeGapTerms([req("b", "rust"), req("a", "Rust"), req("c", "  "), req("d", "Go")], [entry("Python")]);
    expect(gaps).toEqual([{ term: "Go", requirementId: "d" }, { term: "Rust", requirementId: "a" }]);
  });

  it("caps at 5 terms", () => {
    const reqs = ["A1", "B1", "C1", "D1", "E1", "F1"].map((t, i) => req(String(i), t));
    expect(computeGapTerms(reqs, [entry("nothing")])).toHaveLength(5);
  });

  it("with an empty catalog every required term is a gap", () => {
    expect(computeGapTerms([req("1", "SQL")], [])).toEqual([{ term: "SQL", requirementId: "1" }]);
  });
});
