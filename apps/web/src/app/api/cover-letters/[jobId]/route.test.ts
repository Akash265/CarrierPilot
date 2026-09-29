// apps/web/src/app/api/cover-letters/[jobId]/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCompanyResearch, insertCoverLetter } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000019",
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

const USER = "00000000-0000-0000-0000-000000000019";
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
const get = (jobId: string) => GET(new Request(`http://localhost/api/cover-letters/${jobId}`), { params: Promise.resolve({ jobId }) });

describe("GET /api/cover-letters/[jobId]", () => {
  it("returns 404 for a non-UUID jobId", async () => {
    expect((await get("not-a-uuid")).status).toBe(404);
  });

  it("returns no versions and null research when nothing has been generated", async () => {
    const jobId = await insertJob(admin, USER, {});
    expect(await (await get(jobId)).json()).toEqual({ versions: [], research: null });
  });

  it("returns versions newest first with the job's company research", async () => {
    const jobId = await insertJob(admin, USER, { companyName: "Acme" });
    await insertCompanyResearch(admin, USER, { companyKey: "acme", facts: [{ factText: "Acme builds rockets.", sourceUrl: "https://acme.example", sourceTitle: "Acme" }] });
    await insertCoverLetter(admin, USER, jobId, { version: 1 });
    await insertCoverLetter(admin, USER, jobId, { version: 2, origin: "user_edited" });
    const body = await (await get(jobId)).json();
    expect(body.versions.map((v: { version: number; origin: string }) => [v.version, v.origin])).toEqual([[2, "user_edited"], [1, "generated"]]);
    expect(body.versions[0].paragraphs).toHaveLength(4);
    expect(body.research.companyName).toBe("Acme");
  });
});
