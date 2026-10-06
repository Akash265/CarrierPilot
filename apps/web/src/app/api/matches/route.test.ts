import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch, insertModelHistory } from "../../../test/jobsDb";
import { clearResponseModelCache } from "../../../lib/insights/responseModel";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c6",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    OUTCOME_UNDECIDED_DAYS: 30,
    OUTCOME_MODEL_MIN_DECIDED: 30,
    OUTCOME_MODEL_MIN_PER_CLASS: 8,
  }),
}));

import { vi } from "vitest";

const USER = "00000000-0000-0000-0000-0000000000c6";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => {
  clearResponseModelCache();
  return wipeMatchingData(admin, USER);
});
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");
const list = (qs = "") => GET(new Request(`http://localhost/api/matches${qs}`));

describe("GET /api/matches", () => {
  it("lists eligible matches sorted by overall score, best first, by default", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const lowJob = await insertJob(admin, USER, { title: "Low" });
    const highJob = await insertJob(admin, USER, { title: "High" });
    await insertMatch(admin, USER, lowJob, goalId, { overallScore: 40 });
    await insertMatch(admin, USER, highJob, goalId, { overallScore: 90 });

    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches.map((m: { jobTitle: string }) => m.jobTitle)).toEqual(["High", "Low"]);
    expect(body.total).toBe(2);
  });

  it("leaves a closed job out of the eligible list even before the next matching run re-scores it", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const openJob = await insertJob(admin, USER, { title: "Open" });
    const closedJob = await insertJob(admin, USER, { title: "Closed", status: "closed" });
    await insertMatch(admin, USER, openJob, goalId, { overallScore: 40 });
    await insertMatch(admin, USER, closedJob, goalId, { overallScore: 90 });

    const body = await (await list()).json();
    expect(body.matches.map((m: { jobTitle: string }) => m.jobTitle)).toEqual(["Open"]);
    expect(body.total).toBe(1);
  });

  it("lists ineligible matches with their reason when eligible=false", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, { title: "Excluded" });
    await insertMatch(admin, USER, jobId, goalId, { eligible: false, ineligibleReason: "You dismissed this job." });

    const res = await list("?eligible=false");
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match.ineligibleReason).toBe("You dismissed this job.");
    expect(body.matches[0].match.overallScore).toBeNull();
  });

  it("reports the response model's status and keeps the default order without enough history", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, { title: "Only" });
    await insertMatch(admin, USER, jobId, goalId, { overallScore: 60 });

    const body = await (await list("?rank=personal")).json();
    expect(body.ranking).toBe("default");
    expect(body.model).toEqual({
      status: "insufficient_data", decided: 0, responses: 0, nonResponses: 0, minDecided: 30, minPerClass: 8, blendWeight: null,
    });
    expect(body.matches[0].match.personal).toBeNull();
  });

  it("adds a personal prediction to every eligible match once the model is active, without changing the default order", async () => {
    await insertModelHistory(admin, USER, 40);
    const goalId = await insertCareerGoal(admin, USER);
    const strong = await insertJob(admin, USER, { title: "Strong skills" });
    const weak = await insertJob(admin, USER, { title: "Weak skills" });
    await insertMatch(admin, USER, weak, goalId, { overallScore: 80, skillsScore: 0.1 });
    await insertMatch(admin, USER, strong, goalId, { overallScore: 75, skillsScore: 0.95 });

    const body = await (await list()).json();
    expect(body.ranking).toBe("default");
    expect(body.model).toMatchObject({ status: "active", decided: 40, blendWeight: 0.2 });
    expect(body.matches.map((m: { jobTitle: string }) => m.jobTitle)).toEqual(["Weak skills", "Strong skills"]);
    const [weakView, strongView] = body.matches.map((m: { match: { personal: { probability: number; low: number; high: number } } }) => m.match.personal);
    expect(strongView.probability).toBeGreaterThan(weakView.probability);
    expect(strongView.low).toBeLessThanOrEqual(strongView.probability);
    expect(strongView.high).toBeGreaterThanOrEqual(strongView.probability);
  });

  it("re-sorts the eligible list by the blended score with rank=personal when the model is active", async () => {
    await insertModelHistory(admin, USER, 40);
    const goalId = await insertCareerGoal(admin, USER);
    const strong = await insertJob(admin, USER, { title: "Strong skills" });
    const weak = await insertJob(admin, USER, { title: "Weak skills" });
    await insertMatch(admin, USER, weak, goalId, { overallScore: 80, skillsScore: 0.1 });
    await insertMatch(admin, USER, strong, goalId, { overallScore: 75, skillsScore: 0.95 });

    const body = await (await list("?rank=personal")).json();
    expect(body.ranking).toBe("personal");
    expect(body.matches.map((m: { jobTitle: string }) => m.jobTitle)).toEqual(["Strong skills", "Weak skills"]);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
  });

  it("never re-sorts the ineligible list", async () => {
    await insertModelHistory(admin, USER, 40);
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, { title: "Excluded" });
    await insertMatch(admin, USER, jobId, goalId, { eligible: false, ineligibleReason: "You dismissed this job." });

    const body = await (await list("?eligible=false&rank=personal")).json();
    expect(body.ranking).toBe("default");
    expect(body.matches[0].match.personal).toBeNull();
  });

  it("rejects an unknown rank with 400", async () => {
    expect((await list("?rank=bogus")).status).toBe(400);
  });
});
