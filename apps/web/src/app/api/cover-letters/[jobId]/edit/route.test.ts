// apps/web/src/app/api/cover-letters/[jobId]/edit/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCoverLetter } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-00000000001b",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_MODEL_FAST: "test-model",
    ANTHROPIC_MODEL_RESEARCH: "test-research-model",
    COMPANY_RESEARCH_MAX_SEARCHES: 5,
    EMBEDDING_PROVIDER: "voyage",
    VOYAGE_API_KEY: "voyage-test",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));

const USER = "00000000-0000-0000-0000-00000000001b";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const edit = (jobId: string, body: string) =>
  POST(
    new Request(`http://localhost/api/cover-letters/${jobId}/edit`, { method: "POST", body, headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ jobId }) }
  );

describe("POST /api/cover-letters/[jobId]/edit", () => {
  it("returns 404 for a non-UUID jobId and 400 for a non-JSON body", async () => {
    expect((await edit("not-a-uuid", "{}")).status).toBe(404);
    const jobId = await insertJob(admin, USER, {});
    expect((await edit(jobId, "{not json")).status).toBe(400);
  });

  it("returns 400 naming the field for too few paragraphs", async () => {
    const jobId = await insertJob(admin, USER, {});
    const letterId = await insertCoverLetter(admin, USER, jobId, {});
    const res = await edit(jobId, JSON.stringify({ baseVersionId: letterId, paragraphs: ["a", "b"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/paragraphs/);
  });

  it("returns 400 for a base of another job and for a count that differs from the base", async () => {
    const jobId = await insertJob(admin, USER, { title: "Data Engineer" });
    const otherJobId = await insertJob(admin, USER, { title: "Analytics Engineer" });
    const otherLetter = await insertCoverLetter(admin, USER, otherJobId, {});
    expect((await edit(jobId, JSON.stringify({ baseVersionId: otherLetter, paragraphs: ["a", "b", "c", "d"] }))).status).toBe(400);
    const letterId = await insertCoverLetter(admin, USER, jobId, {});
    const res = await edit(jobId, JSON.stringify({ baseVersionId: letterId, paragraphs: ["a", "b", "c", "d", "e"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/number of paragraphs/i);
  });

  it("creates the next version as user_edited and returns it with 201", async () => {
    const jobId = await insertJob(admin, USER, {});
    const letterId = await insertCoverLetter(admin, USER, jobId, {});
    const res = await edit(jobId, JSON.stringify({ baseVersionId: letterId, paragraphs: ["A", "B", "C", "D"] }));
    expect(res.status).toBe(201);
    const { coverLetter } = await res.json();
    expect(coverLetter).toMatchObject({ version: 2, origin: "user_edited", parentCoverLetterId: letterId, requiresReview: false });
    expect(coverLetter.paragraphs.map((p: { text: string }) => p.text)).toEqual(["A", "B", "C", "D"]);
  });
});
