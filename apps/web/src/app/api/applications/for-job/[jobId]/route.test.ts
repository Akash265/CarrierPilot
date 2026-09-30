import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertApplication, insertPitch } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b2",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b2";
let admin: postgres.Sql;
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");
const get = (jobId: string) => GET(new Request("http://localhost"), { params: Promise.resolve({ jobId }) });

describe("GET /api/applications/for-job/[jobId]", () => {
  it("404s a non-UUID", async () => {
    expect((await get("x")).status).toBe(404);
  });

  it("returns null plus document options before applying, and the application after", async () => {
    const jobId = await insertJob(admin, USER, {});
    const pitchId = await insertPitch(admin, USER, jobId, {});
    let body = await (await get(jobId)).json();
    expect(body.application).toBeNull();
    expect(body.documentOptions).toEqual({ resumes: [], pitches: [{ id: pitchId, version: 1, origin: "generated" }], coverLetters: [] });

    const appId = await insertApplication(admin, USER, { jobId });
    body = await (await get(jobId)).json();
    expect(body.application).toEqual({ id: appId, status: "applied", appliedAt: "2026-09-30" });
  });
});
