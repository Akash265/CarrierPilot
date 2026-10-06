import { describe, it, expect } from "vitest";
import { scoreKeywordCoverage } from "@ai-career/resume-optimization";
import { findMissedTerms, joinOptimizedText } from "./missedTerms";

describe("findMissedTerms", () => {
  it("returns the terms not contained in the text, case-insensitively, in input order", () => {
    expect(findMissedTerms(["SQL", "Tableau", "python", "dbt"], "Built SQL models in Python")).toEqual(["Tableau", "dbt"]);
  });

  it("skips blank terms, de-duplicates case-insensitively and trims what it returns", () => {
    expect(findMissedTerms([" Tableau ", "", "  ", "tableau", "TABLEAU"], "nothing here")).toEqual(["Tableau"]);
  });

  it("matches plain substrings, so C++ needs no escaping", () => {
    expect(findMissedTerms(["C++", "Go"], "Wrote C++ services")).toEqual(["Go"]);
  });

  it("returns nothing when there are no terms", () => {
    expect(findMissedTerms([], "anything")).toEqual([]);
  });

  it.each([
    [["SQL", "Tableau", "Python"], "Built SQL models in Python"],
    [["Kubernetes", "Terraform"], "No infrastructure here"],
    [["Spark"], "Apache Spark pipelines"],
    [["C++", "Rust", "Go", "Java"], "C++ and Java"],
  ])("agrees with scoreKeywordCoverage on %j", (terms, text) => {
    const coverage = scoreKeywordCoverage(terms.map((termText) => ({ termText, requirementLevel: "required" as const })), text);
    expect(findMissedTerms(terms, text).length).toBe(Math.round(terms.length * (1 - coverage.requiredKeywordCoverage)));
  });
});

describe("joinOptimizedText", () => {
  it("joins each bullet's optimizedText with newlines, the text the ATS score used", () => {
    expect(joinOptimizedText([{ optimizedText: "a" }, { optimizedText: "b", sourceFactId: "x" }])).toBe("a\nb");
  });

  it("ignores malformed entries and non-arrays", () => {
    expect(joinOptimizedText([{ optimizedText: 1 }, null, "x", { optimizedText: "ok" }])).toBe("ok");
    expect(joinOptimizedText({ optimizedText: "no" })).toBe("");
    expect(joinOptimizedText(null)).toBe("");
  });
});
