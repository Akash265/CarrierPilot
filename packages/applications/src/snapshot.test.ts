import { describe, it, expect } from "vitest";
import { buildFeatureSnapshot, type SnapshotJobInput, type SnapshotMatchInput } from "./snapshot";

const JOB: SnapshotJobInput = {
  title: "Data Engineer", companyName: "Acme", seniority: "senior", countryCode: "DE", locationRaw: "Berlin",
  workMode: "remote", employmentType: "full_time", salaryMin: "70000", salaryMax: "90000", salaryCurrency: "EUR",
  salaryPeriod: "year", sponsorship: "offered", postedAt: new Date("2026-09-20T08:00:00Z"), firstSeenAt: new Date("2026-09-21T00:00:00Z"),
};
const MATCH: SnapshotMatchInput = {
  careerGoalId: "g1", eligible: true, overallScore: "78", skillsScore: "0.8", experienceScore: "1", locationScore: "0.9",
  sponsorshipScore: "1", roleScore: "0.7", salaryScore: null, industryScore: "0.5", freshnessScore: "0.6", semanticScore: "0.66",
  computedAt: new Date("2026-09-29T00:00:00Z"),
};

describe("buildFeatureSnapshot", () => {
  it("records an ingested application's job, match, ATS and document refs as numbers", () => {
    const s = buildFeatureSnapshot({
      kind: "ingested", job: JOB, match: MATCH, appliedAt: "2026-09-30", missedRequiredTerms: ["Tableau"],
      ats: { overallScore: "82", requiredKeywordCoverage: "0.9", preferredKeywordCoverage: "0.5", semanticSimilarity: null },
      documents: {
        resume: { id: "r1", version: 3, origin: null, sourceProfileContentHash: "h" },
        pitch: { id: "p1", version: 2, origin: "user_edited", sourceProfileContentHash: null },
        coverLetter: null,
      },
    });
    expect(s).toEqual({
      snapshotVersion: 2,
      external: false,
      job: {
        title: "Data Engineer", companyName: "Acme", seniority: "senior", countryCode: "DE", locationRaw: "Berlin", workMode: "remote",
        employmentType: "full_time", salaryMin: 70000, salaryMax: 90000, salaryCurrency: "EUR", salaryPeriod: "year",
        sponsorship: "offered", postingAgeDays: 9,
      },
      match: {
        careerGoalId: "g1", eligible: true, overallScore: 78, skillsScore: 0.8, experienceScore: 1, locationScore: 0.9,
        sponsorshipScore: 1, roleScore: 0.7, salaryScore: null, industryScore: 0.5, freshnessScore: 0.6, semanticScore: 0.66,
        computedAt: "2026-09-29T00:00:00.000Z",
      },
      ats: { overallScore: 82, requiredKeywordCoverage: 0.9, preferredKeywordCoverage: 0.5, semanticSimilarity: null, missedRequiredTerms: ["Tableau"] },
      documents: {
        resume: { id: "r1", version: 3, origin: null, sourceProfileContentHash: "h" },
        pitch: { id: "p1", version: 2, origin: "user_edited", sourceProfileContentHash: null },
        coverLetter: null,
      },
    });
  });

  it("uses firstSeenAt when postedAt is missing, never a negative age, and null (not zero) for missing parts", () => {
    const s = buildFeatureSnapshot({
      kind: "ingested", job: { ...JOB, postedAt: null, firstSeenAt: new Date("2026-10-02T00:00:00Z"), salaryMin: null },
      match: null, ats: null, documents: { resume: null, pitch: null, coverLetter: null }, appliedAt: "2026-09-30", missedRequiredTerms: null,
    });
    expect(s.job.postingAgeDays).toBe(0);
    expect(s.job.salaryMin).toBeNull();
    expect(s.match).toBeNull();
    expect(s.ats).toBeNull();
  });

  it("records an external application with only company and title", () => {
    const s = buildFeatureSnapshot({ kind: "external", companyName: "Globex", jobTitle: "Analyst" });
    expect(s.snapshotVersion).toBe(2);
    expect(s.external).toBe(true);
    expect(s.job).toMatchObject({ companyName: "Globex", title: "Analyst", workMode: null, postingAgeDays: null });
    expect(s.match).toBeNull();
    expect(s.ats).toBeNull();
    expect(s.documents).toBeNull();
  });
});
