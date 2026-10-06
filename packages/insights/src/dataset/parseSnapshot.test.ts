import { describe, it, expect } from "vitest";
import { parseSnapshot } from "./parseSnapshot";

const V2 = {
  snapshotVersion: 2,
  external: false,
  job: { title: "Data Engineer", companyName: "Acme", workMode: "remote", countryCode: "de", salaryMin: 70000, salaryMax: 90000,
    salaryCurrency: "EUR", postingAgeDays: 4 },
  match: {
    careerGoalId: "g1", eligible: true, overallScore: 78, skillsScore: 0.8, experienceScore: 1, locationScore: 0.9, sponsorshipScore: 1,
    roleScore: 0.7, salaryScore: null, industryScore: 0.5, freshnessScore: 0.6, semanticScore: 0.66,
  },
  ats: { overallScore: 82, requiredKeywordCoverage: 0.9, preferredKeywordCoverage: 0.5, semanticSimilarity: null,
    missedRequiredTerms: ["Tableau", " ", 7] },
  documents: {
    resume: { id: "r1", version: 1, origin: null },
    pitch: { id: "p1", version: 2, origin: "user_edited" },
    coverLetter: null,
  },
};

describe("parseSnapshot", () => {
  it("reads a v2 snapshot", () => {
    expect(parseSnapshot(V2)).toEqual({
      external: false, careerGoalId: "g1", matchScore: 78, workMode: "remote", countryCode: "DE",
      salaryMin: 70000, salaryMax: 90000, salaryCurrency: "EUR", postingAgeDays: 4, atsScore: 82, requiredKeywordCoverage: 0.9,
      missedRequiredTerms: ["Tableau"], documents: { resume: true, pitch: true, coverLetter: false, edited: true },
      factors: {
        skillsScore: 0.8, experienceScore: 1, locationScore: 0.9, sponsorshipScore: 1, roleScore: 0.7, salaryScore: null,
        industryScore: 0.5, freshnessScore: 0.6, semanticScore: 0.66,
      },
    });
  });

  it("reads a v1 snapshot with missed terms unknown", () => {
    const { ats, ...rest } = V2;
    const { missedRequiredTerms, ...v1Ats } = ats;
    expect(parseSnapshot({ ...rest, snapshotVersion: 1, ats: v1Ats }).missedRequiredTerms).toBeNull();
  });

  it("drops the match score of an ineligible match, and an unknown work mode", () => {
    const parsed = parseSnapshot({ ...V2, match: { ...V2.match, eligible: false }, job: { ...V2.job, workMode: "unknown" } });
    expect(parsed.matchScore).toBeNull();
    expect(parsed.factors).toBeNull();
    expect(parsed.careerGoalId).toBe("g1");
    expect(parsed.workMode).toBeNull();
  });

  it("reads an external snapshot as external with nothing else known", () => {
    expect(parseSnapshot({
      snapshotVersion: 2, external: true, job: { title: "Analyst", companyName: "Globex", workMode: null }, match: null, ats: null, documents: null,
    })).toEqual({
      external: true, careerGoalId: null, matchScore: null, workMode: null, countryCode: null, salaryMin: null, salaryMax: null,
      salaryCurrency: null, postingAgeDays: null, atsScore: null, requiredKeywordCoverage: null, missedRequiredTerms: null, documents: null,
      factors: null,
    });
  });

  it.each([null, "x", 42, [], { job: "nope", match: [1], ats: "x", documents: 5 }])("never throws on a malformed snapshot (%j)", (raw) => {
    const parsed = parseSnapshot(raw);
    expect(parsed.external).toBe(false);
    expect(parsed.matchScore).toBeNull();
    expect(parsed.documents).toBeNull();
    expect(parsed.factors).toBeNull();
  });

  it("reads each factor score tolerantly: a missing or non-number score is null, the others are kept", () => {
    const parsed = parseSnapshot({ ...V2, match: { ...V2.match, roleScore: "0.7", industryScore: undefined } });
    expect(parsed.factors).toMatchObject({ skillsScore: 0.8, roleScore: null, industryScore: null, salaryScore: null });
  });

  it("rejects non-finite numbers", () => {
    expect(parseSnapshot({ ...V2, ats: { ...V2.ats, overallScore: "82" } }).atsScore).toBeNull();
  });
});
