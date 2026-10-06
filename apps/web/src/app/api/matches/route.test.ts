import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
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

vi.mock("@ai-career/insights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/insights")>();
  return { ...actual, trainResponseModel: vi.fn(actual.trainResponseModel) };
});

import { blendedScore, trainResponseModel } from "@ai-career/insights";

const USER = "00000000-0000-0000-0000-0000000000c6";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => {
  clearResponseModelCache();
  return wipeMatchingData(admin, USER);
});
afterEach(() => vi.restoreAllMocks());
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

  it("pages the personal order in code: full first page, the remainder next, an empty page past the end, ties by job id", async () => {
    await insertModelHistory(admin, USER, 40);
    const goalId = await insertCareerGoal(admin, USER);
    // 24 distinct matches plus 3 identical ones (same overall and factors -> equal blended and overall scores).
    for (let i = 0; i < 24; i++) {
      const jobId = await insertJob(admin, USER, { title: `Job ${i}` });
      await insertMatch(admin, USER, jobId, goalId, { overallScore: 60 + (i % 5) * 5, skillsScore: (i + 0.5) / 24 });
    }
    const tied: string[] = [];
    for (let i = 0; i < 3; i++) {
      const jobId = await insertJob(admin, USER, { title: `Tied ${i}` });
      await insertMatch(admin, USER, jobId, goalId, { overallScore: 70, skillsScore: 0.5 });
      tied.push(jobId);
    }

    type Item = { jobId: string; match: { overallScore: number; personal: { probability: number } } };
    const page = async (n: number) => (await list(`?rank=personal&page=${n}`)).json();
    const [first, second, third] = [await page(1), await page(2), await page(3)];
    expect(first).toMatchObject({ ranking: "personal", page: 1, pageSize: 25, total: 27 });
    expect(first.matches).toHaveLength(25);
    expect(second).toMatchObject({ ranking: "personal", page: 2, total: 27 });
    expect(second.matches).toHaveLength(2);
    expect(third).toMatchObject({ ranking: "personal", page: 3, total: 27, matches: [] });

    const all: Item[] = [...first.matches, ...second.matches];
    expect(new Set(all.map((m) => m.jobId)).size).toBe(27);
    const keyed = all.map((m) => ({
      jobId: m.jobId, overall: m.match.overallScore, blended: blendedScore(m.match.overallScore, m.match.personal.probability, 0.2),
    }));
    const expected = [...keyed].sort((a, b) => b.blended - a.blended || b.overall - a.overall || (a.jobId < b.jobId ? -1 : 1));
    expect(keyed.map((k) => k.jobId)).toEqual(expected.map((k) => k.jobId));
    const tiedInOrder = all.map((m) => m.jobId).filter((id) => tied.includes(id));
    expect(tiedInOrder).toEqual([...tied].sort());
  });

  it("degrades to the default order, logging only the error class, when training throws", async () => {
    await insertModelHistory(admin, USER, 40);
    const goalId = await insertCareerGoal(admin, USER);
    const strong = await insertJob(admin, USER, { title: "Strong skills" });
    const weak = await insertJob(admin, USER, { title: "Weak skills" });
    await insertMatch(admin, USER, weak, goalId, { overallScore: 80, skillsScore: 0.1 });
    await insertMatch(admin, USER, strong, goalId, { overallScore: 75, skillsScore: 0.95 });
    vi.mocked(trainResponseModel).mockImplementationOnce(() => {
      throw new RangeError("secret application text");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await list("?rank=personal");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ranking).toBe("default");
    expect(body.model.status).toBe("no_pattern");
    expect(body.matches.map((m: { jobTitle: string }) => m.jobTitle)).toEqual(["Weak skills", "Strong skills"]);
    expect(body.matches.every((m: { match: { personal: unknown } }) => m.match.personal === null)).toBe(true);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "response_model_failed", error: "RangeError" }));
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret");
  });
});
