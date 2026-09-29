import { describe, it, expect } from "vitest";
import type { EvidenceCatalogEntry } from "@ai-career/resume-optimization";
import { computeGapTerms, containsTerm } from "./computeGapTerms";

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

  it("caps at 5 terms, keeping the first five in sorted order", () => {
    const reqs = ["A1", "B1", "C1", "D1", "E1", "F1"].map((t, i) => req(String(i), t));
    expect(computeGapTerms(reqs, [entry("nothing")])).toEqual([
      { term: "A1", requirementId: "0" },
      { term: "B1", requirementId: "1" },
      { term: "C1", requirementId: "2" },
      { term: "D1", requirementId: "3" },
      { term: "E1", requirementId: "4" },
    ]);
  });

  it("with an empty catalog every required term is a gap", () => {
    expect(computeGapTerms([req("1", "SQL")], [])).toEqual([{ term: "SQL", requirementId: "1" }]);
  });

  it("uses a boundary-aware match so short terms are not hidden by longer words", () => {
    expect(computeGapTerms([req("1", "Go")], [entry("Worked at Google")])).toEqual([{ term: "Go", requirementId: "1" }]);
    expect(computeGapTerms([req("1", "Go")], [entry("Wrote Go services")])).toEqual([]);
    expect(computeGapTerms([req("1", "C++")], [entry("Modern C++ code")])).toEqual([]);
    expect(computeGapTerms([req("1", "Java")], [entry("Built a JavaScript app")])).toEqual([{ term: "Java", requirementId: "1" }]);
  });
});

describe("containsTerm", () => {
  it("matches only when the term has no alphanumeric character adjacent to it", () => {
    expect(containsTerm("worked at google", "go")).toBe(false);
    expect(containsTerm("wrote go services", "go")).toBe(true);
    expect(containsTerm("modern c++ code", "c++")).toBe(true);
    expect(containsTerm("javascript", "java")).toBe(false);
    expect(containsTerm("go", "go")).toBe(true);
  });
});
