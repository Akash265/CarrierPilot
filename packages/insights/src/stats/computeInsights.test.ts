import { describe, it, expect } from "vitest";
import { computeInsights, OTHERS_KEY } from "./computeInsights";
import type { OutcomeLabel, OutcomeRecord } from "../types";

let seq = 0;
function record(response: OutcomeLabel, interview: OutcomeLabel, over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  seq += 1;
  return {
    applicationId: `a${seq}`, external: false, appliedAt: "2026-10-01",
    response: { label: response, reason: "" }, interview: { label: interview, reason: "" },
    roleFamily: { key: "data engineer", label: "Data Engineer" }, company: { key: "acme", label: "Acme" },
    workMode: "remote", countryCode: "DE", salaryVsFloor: null, matchScore: 72, atsScore: 88, requiredKeywordCoverage: 0.9,
    postingAgeDays: 3, documents: { resume: true, pitch: false, coverLetter: false, edited: false }, missedRequiredTerms: null,
    ...over,
  };
}
const times = (n: number, make: () => OutcomeRecord) => Array.from({ length: n }, make);

describe("computeInsights headlines", () => {
  it("counts every label and gives a rate with an interval at or above the minimum", () => {
    const records = [
      ...times(2, () => record("positive", "positive")),
      ...times(3, () => record("negative", "negative")),
      record("undecided", "undecided"),
      record("excluded", "excluded", { external: true }),
    ];
    const insights = computeInsights(records, { minBucket: 5 });
    expect(insights.totals).toEqual({ applications: 7, external: 1 });
    expect(insights.tiers.response).toMatchObject({ decided: 5, positives: 2, negatives: 3, undecided: 1, excluded: 1, rate: 0.4 });
    expect(insights.tiers.response.interval!.low).toBeCloseTo(0.1176, 4);
    expect(insights.tiers.response.interval!.high).toBeCloseTo(0.7693, 4);
  });

  it("shows counts but no rate below the minimum", () => {
    const insights = computeInsights(times(4, () => record("positive", "negative")), { minBucket: 5 });
    expect(insights.tiers.response).toMatchObject({ decided: 4, positives: 4, rate: null, interval: null });
  });

  it("handles an empty dataset", () => {
    const insights = computeInsights([], { minBucket: 5 });
    expect(insights.totals).toEqual({ applications: 0, external: 0 });
    expect(insights.tiers.interview).toEqual({ decided: 0, positives: 0, negatives: 0, undecided: 0, excluded: 0, rate: null, interval: null });
    expect(insights.breakdowns.response.every((d) => d.buckets.length === 0 && d.unknownCount === 0)).toBe(true);
    expect(insights.patterns).toEqual({ tier: "response", missedTerms: [], highCoverage: null, negativesWithData: 0, positivesWithData: 0 });
  });
});

describe("computeInsights breakdowns", () => {
  const dimension = (insights: ReturnType<typeof computeInsights>, key: string, tier: "response" | "interview" = "response") =>
    insights.breakdowns[tier].find((d) => d.key === key)!;

  it("lists all 13 dimensions in the documented order", () => {
    expect(computeInsights([], { minBucket: 2 }).breakdowns.response.map((d) => d.key)).toEqual([
      "roleFamily", "company", "workMode", "country", "salaryVsFloor", "matchScore", "atsScore", "keywordCoverage", "postingAge",
      "resumeSent", "pitchSent", "coverLetterSent", "edited",
    ]);
  });

  it("flags a bucket whose interval clears the overall rate, in both directions", () => {
    const records = [
      ...times(10, () => record("positive", "negative", { roleFamily: { key: "analytics engineer", label: "Analytics Engineer" } })),
      ...times(20, () => record("negative", "negative")),
    ];
    const roles = dimension(computeInsights(records, { minBucket: 5 }), "roleFamily");
    expect(roles.buckets.map((b) => [b.label, b.decided, b.positives, b.standsOut])).toEqual([
      ["Data Engineer", 20, 0, "lower"],
      ["Analytics Engineer", 10, 10, "higher"],
    ]);
  });

  it("never rates or flags a bucket below the minimum", () => {
    const records = [...times(3, () => record("positive", "negative", { workMode: "hybrid" })), ...times(10, () => record("negative", "negative"))];
    const hybrid = dimension(computeInsights(records, { minBucket: 5 }), "workMode").buckets.find((b) => b.key === "hybrid")!;
    expect(hybrid).toMatchObject({ decided: 3, positives: 3, rate: null, interval: null, standsOut: null });
  });

  it("uses the fixed band order and shows only bands that have applications", () => {
    const records = [record("positive", "positive", { matchScore: 90 }), record("negative", "negative", { matchScore: 10 })];
    expect(dimension(computeInsights(records, { minBucket: 2 }), "matchScore").buckets.map((b) => b.label)).toEqual(["Under 50", "85+"]);
  });

  it("counts unknown values separately and ignores excluded applications entirely", () => {
    const records = [
      record("positive", "positive", { matchScore: null }),
      record("negative", "negative", { matchScore: null }),
      record("excluded", "excluded", { matchScore: null }),
      record("negative", "negative"),
    ];
    const match = dimension(computeInsights(records, { minBucket: 2 }), "matchScore");
    expect(match.unknownCount).toBe(2);
    expect(match.buckets).toHaveLength(1);
  });

  it("counts undecided applications in a bucket without deciding them", () => {
    const bucket = dimension(computeInsights([record("undecided", "undecided")], { minBucket: 2 }), "workMode").buckets[0];
    expect(bucket).toMatchObject({ key: "remote", decided: 0, positives: 0, undecided: 1, rate: null });
  });

  it("caps companies at 15 buckets plus an unflagged Others bucket, ordered by decided count", () => {
    const records = Array.from({ length: 17 }, (_, i) =>
      times(i === 0 ? 3 : 1, () => record("negative", "negative", { company: { key: `c${i}`, label: `Company ${i}` } }))
    ).flat();
    const company = dimension(computeInsights(records, { minBucket: 2 }), "company");
    expect(company.buckets).toHaveLength(16);
    expect(company.buckets[0]).toMatchObject({ key: "c0", decided: 3 });
    expect(company.buckets[15]).toMatchObject({ key: OTHERS_KEY, label: "Others", decided: 2, standsOut: null });
  });

  it("splits the yes/no document dimensions and treats no document data as unknown", () => {
    const records = [
      record("positive", "positive", { documents: { resume: true, pitch: true, coverLetter: false, edited: true } }),
      record("negative", "negative", { documents: { resume: false, pitch: false, coverLetter: false, edited: false } }),
      record("negative", "negative", { documents: null }),
    ];
    const insights = computeInsights(records, { minBucket: 2 });
    expect(dimension(insights, "pitchSent").buckets.map((b) => [b.label, b.decided])).toEqual([["Yes", 1], ["No", 1]]);
    expect(dimension(insights, "edited").unknownCount).toBe(1);
  });

  it("computes interview breakdowns from interview labels", () => {
    const records = [record("positive", "negative"), record("positive", "positive")];
    expect(dimension(computeInsights(records, { minBucket: 2 }), "workMode", "interview").buckets[0]).toMatchObject({ decided: 2, positives: 1 });
  });
});

describe("computeInsights rejection patterns", () => {
  it("uses the interview tier once it has a rate, else the response tier", () => {
    expect(computeInsights(times(2, () => record("positive", "undecided")), { minBucket: 2 }).patterns.tier).toBe("response");
    expect(computeInsights(times(2, () => record("positive", "negative")), { minBucket: 2 }).patterns.tier).toBe("interview");
  });

  it("lists terms missed in at least two negatives, with counts on both sides", () => {
    const records = [
      record("negative", "negative", { missedRequiredTerms: ["Tableau", "dbt"] }),
      record("negative", "negative", { missedRequiredTerms: ["tableau", "Airflow"] }),
      record("negative", "negative", { missedRequiredTerms: ["dbt", "Tableau", "TABLEAU"] }),
      record("positive", "positive", { missedRequiredTerms: ["Tableau"] }),
      record("positive", "positive", { missedRequiredTerms: [] }),
      record("negative", "negative", { missedRequiredTerms: null }),
      record("undecided", "undecided", { missedRequiredTerms: ["Tableau"] }),
    ];
    const { patterns } = computeInsights(records, { minBucket: 2 });
    expect(patterns.tier).toBe("interview");
    expect(patterns.missedTerms).toEqual([
      { term: "Tableau", missedInNegatives: 3, missedInPositives: 1, negativesWithData: 3, positivesWithData: 2 },
      { term: "dbt", missedInNegatives: 2, missedInPositives: 0, negativesWithData: 3, positivesWithData: 2 },
    ]);
    expect(patterns.negativesWithData).toBe(3);
    expect(patterns.positivesWithData).toBe(2);
  });

  it("reports zero with-data counts when no record has missedRequiredTerms data", () => {
    const records = times(3, () => record("negative", "negative", { missedRequiredTerms: null }));
    const { patterns } = computeInsights(records, { minBucket: 2 });
    expect(patterns).toMatchObject({ missedTerms: [], negativesWithData: 0, positivesWithData: 0 });
  });

  it("keeps at most 20 terms", () => {
    const terms = Array.from({ length: 25 }, (_, i) => `term${String(i).padStart(2, "0")}`);
    const records = times(2, () => record("negative", "negative", { missedRequiredTerms: terms }));
    expect(computeInsights(records, { minBucket: 2 }).patterns.missedTerms).toHaveLength(20);
  });

  it("reports high-coverage results only at or above the minimum", () => {
    const high = (label: OutcomeLabel) => record(label, label, { requiredKeywordCoverage: 0.85 });
    const low = (label: OutcomeLabel) => record(label, label, { requiredKeywordCoverage: 0.4 });
    const records = [...times(5, () => high("negative")), ...times(5, () => low("positive"))];
    const { patterns } = computeInsights(records, { minBucket: 5 });
    expect(patterns.highCoverage).toMatchObject({ decided: 5, positives: 0, rate: 0, standsOut: "lower" });
    expect(computeInsights(records.slice(1), { minBucket: 5 }).patterns.highCoverage).toBeNull();
  });
});
