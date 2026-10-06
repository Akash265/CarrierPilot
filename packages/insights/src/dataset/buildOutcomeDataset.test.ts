import { describe, it, expect } from "vitest";
import { buildOutcomeDataset, salaryVsFloor } from "./buildOutcomeDataset";
import { parseSnapshot } from "./parseSnapshot";
import type { InsightApplication, InsightGoal, InsightInputs } from "../types";

const NOW = new Date("2026-10-06T12:00:00Z");
const OPTS = { now: NOW, undecidedDays: 30 };
const GOAL: InsightGoal = {
  id: "g1", confirmedAt: new Date("2026-09-01T00:00:00Z"), targetRoles: ["Data Engineer", "Analytics Engineer"],
  salaryFloorNormalized: 80000, salaryCurrency: "EUR", salaryIsParsed: true,
};
const SNAPSHOT = {
  snapshotVersion: 2, external: false,
  job: { workMode: "hybrid", countryCode: "DE", salaryMin: 70000, salaryMax: 75000, salaryCurrency: "EUR", postingAgeDays: 3 },
  match: { careerGoalId: "g1", eligible: true, overallScore: 72 },
  ats: { overallScore: 88, requiredKeywordCoverage: 0.5, missedRequiredTerms: ["Tableau"] },
  documents: { resume: { origin: null }, pitch: null, coverLetter: null },
};
const app = (over: Partial<InsightApplication>): InsightApplication => ({
  id: "a1", jobId: "j1", companyName: "Acme", jobTitle: "Senior Data Engineer", status: "applied", appliedAt: "2026-10-01",
  createdAt: new Date("2026-10-01T08:00:00Z"), featureSnapshot: SNAPSHOT, ...over,
});

describe("buildOutcomeDataset", () => {
  it("builds one record per application with labels, role family and dimensions", () => {
    const inputs: InsightInputs = {
      applications: [app({ status: "rejected" })],
      events: [{ applicationId: "a1", type: "status_change", occurredAt: new Date("2026-10-03T00:00:00Z"), fromStatus: "applied", toStatus: "screening" }],
      goals: [GOAL],
    };
    const [record] = buildOutcomeDataset(inputs, OPTS);
    expect(record).toEqual({
      applicationId: "a1", external: false, appliedAt: "2026-10-01",
      response: { label: "positive", reason: "Response: reached screening on 2026-10-03" },
      interview: { label: "negative", reason: "No interview: rejected" },
      roleFamily: { key: "data engineer", label: "Data Engineer" },
      company: { key: "acme", label: "Acme" },
      workMode: "hybrid", countryCode: "DE", salaryVsFloor: "below", matchScore: 72, atsScore: 88, requiredKeywordCoverage: 0.5,
      postingAgeDays: 3, documents: { resume: true, pitch: false, coverLetter: false, edited: false }, missedRequiredTerms: ["Tableau"],
    });
  });

  it("only routes each application's own events to it", () => {
    const inputs: InsightInputs = {
      applications: [app({ id: "a1" }), app({ id: "a2" })],
      events: [{ applicationId: "a2", type: "interview", occurredAt: new Date("2026-10-02T00:00:00Z"), fromStatus: null, toStatus: null }],
      goals: [GOAL],
    };
    const byId = new Map(buildOutcomeDataset(inputs, OPTS).map((r) => [r.applicationId, r]));
    expect(byId.get("a1")!.interview.label).toBe("undecided");
    expect(byId.get("a2")!.interview.label).toBe("positive");
  });

  it("orders records most recently applied first, and keys companies case-insensitively", () => {
    const records = buildOutcomeDataset({
      applications: [
        app({ id: "old", appliedAt: "2026-09-01", companyName: "acme  corp" }),
        app({ id: "new", appliedAt: "2026-10-02", companyName: " Acme Corp" }),
      ],
      events: [], goals: [GOAL],
    }, OPTS);
    expect(records.map((r) => r.applicationId)).toEqual(["new", "old"]);
    expect(records.map((r) => r.company.key)).toEqual(["acme corp", "acme corp"]);
    expect(records[0].company.label).toBe("Acme Corp");
  });

  it("gives an external application only role family and company", () => {
    const [record] = buildOutcomeDataset({
      applications: [app({
        jobId: null, jobTitle: "Analytics Engineer", createdAt: new Date("2026-10-01T00:00:00Z"),
        featureSnapshot: { snapshotVersion: 2, external: true, job: { workMode: null }, match: null, ats: null, documents: null },
      })],
      events: [], goals: [GOAL],
    }, OPTS);
    expect(record).toMatchObject({
      external: true, roleFamily: { key: "analytics engineer", label: "Analytics Engineer" }, company: { key: "acme" },
      workMode: null, countryCode: null, salaryVsFloor: null, matchScore: null, atsScore: null, requiredKeywordCoverage: null,
      postingAgeDays: null, documents: null, missedRequiredTerms: null,
    });
  });

  it("survives a malformed snapshot with only the application's own columns", () => {
    const [record] = buildOutcomeDataset({ applications: [app({ featureSnapshot: "garbage" })], events: [], goals: [GOAL] }, OPTS);
    expect(record.company.label).toBe("Acme");
    expect(record.roleFamily.key).toBe("data engineer");
    expect(record.matchScore).toBeNull();
  });
});

describe("salaryVsFloor", () => {
  const snap = (job: Record<string, unknown>) => parseSnapshot({ job });

  it("compares the job's max (else min) annual salary with the floor", () => {
    expect(salaryVsFloor(snap({ salaryMin: 70000, salaryMax: 90000, salaryCurrency: "EUR" }), GOAL)).toBe("at_or_above");
    expect(salaryVsFloor(snap({ salaryMin: 80000, salaryMax: null, salaryCurrency: "eur" }), GOAL)).toBe("at_or_above");
    expect(salaryVsFloor(snap({ salaryMin: 60000, salaryMax: 79999, salaryCurrency: "EUR" }), GOAL)).toBe("below");
  });

  it("is unknown without a salary, a parsed floor, a goal, or a matching currency", () => {
    expect(salaryVsFloor(snap({ salaryCurrency: "EUR" }), GOAL)).toBeNull();
    expect(salaryVsFloor(snap({ salaryMax: 90000, salaryCurrency: "USD" }), GOAL)).toBeNull();
    expect(salaryVsFloor(snap({ salaryMax: 90000, salaryCurrency: "EUR" }), { ...GOAL, salaryIsParsed: false })).toBeNull();
    expect(salaryVsFloor(snap({ salaryMax: 90000, salaryCurrency: "EUR" }), null)).toBeNull();
  });
});
