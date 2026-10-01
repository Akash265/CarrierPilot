import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertApplication, insertCoverLetter } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b1",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b1";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET, POST } = await import("./route");
const post = (body: string) =>
  POST(new Request("http://localhost/api/applications", { method: "POST", body, headers: { "Content-Type": "application/json" } }));
const get = (query = "") => GET(new Request(`http://localhost/api/applications${query}`));

describe("POST /api/applications", () => {
  it("returns 400 for bad JSON and for a body with neither jobId nor external", async () => {
    expect((await post("{nope")).status).toBe(400);
    const res = await post("{}");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/jobId/);
  });

  it("creates an ingested application (201), then 409 on a second one", async () => {
    const jobId = await insertJob(admin, USER, {});
    const res = await post(JSON.stringify({ jobId }));
    expect(res.status).toBe(201);
    expect((await res.json()).application).toMatchObject({ jobId, companyName: "Acme", status: "applied", external: false });
    expect((await post(JSON.stringify({ jobId }))).status).toBe(409);
  });

  it("returns 404 for an unknown job and 422 for another job's document", async () => {
    expect((await post(JSON.stringify({ jobId: "11111111-1111-4111-8111-111111111111" }))).status).toBe(404);
    const jobId = await insertJob(admin, USER, { title: "Data Engineer" });
    const otherJob = await insertJob(admin, USER, { title: "Analytics Engineer" });
    const letter = await insertCoverLetter(admin, USER, otherJob, {});
    expect((await post(JSON.stringify({ jobId, coverLetterId: letter }))).status).toBe(422);
  });

  it("creates an external application", async () => {
    const res = await post(JSON.stringify({ external: { companyName: "Globex", jobTitle: "Analyst", jobUrl: "https://globex.example/1" } }));
    expect(res.status).toBe(201);
    expect((await res.json()).application).toMatchObject({ jobId: null, external: true, jobUrl: "https://globex.example/1" });
  });
});

describe("GET /api/applications", () => {
  it("lists applications with a due count, filters by status and due, and 400s an unknown status", async () => {
    await insertApplication(admin, USER, { companyName: "A", followUpAt: "2020-01-01" });
    await insertApplication(admin, USER, { companyName: "B", status: "rejected", terminal: true, followUpAt: "2020-01-01" });
    const all = await (await get()).json();
    expect(all.applications).toHaveLength(2);
    expect(all.dueCount).toBe(1);
    expect((await (await get("?status=rejected")).json()).applications.map((a: { companyName: string }) => a.companyName)).toEqual(["B"]);
    expect((await (await get("?due=1")).json()).applications.map((a: { companyName: string }) => a.companyName)).toEqual(["A"]);
    expect((await get("?status=ghosted")).status).toBe(400);
  });
});
