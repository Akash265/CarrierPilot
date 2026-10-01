import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import {
  openAdminDb, wipeMatchingData, insertJob, insertSource, insertPosting, insertProfile, insertGeneratedPdf, insertAutomationSession,
} from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000008a7",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../lib/browser-automation/enqueue", () => ({ enqueueAutofill: vi.fn() }));
import { enqueueAutofill } from "../../../lib/browser-automation/enqueue";

const USER = "00000000-0000-0000-0000-0000000008a7";
let admin: postgres.Sql;

const wipe = async () => {
  await wipeMatchingData(admin, USER);
  await admin`DELETE FROM candidate_profiles WHERE user_id = ${USER}`;
};
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueAutofill).mockReset().mockResolvedValue(undefined);
  await wipe();
});
afterAll(async () => {
  await wipe();
  await admin.end();
});

const { GET, POST } = await import("./route");
const post = (body: string) =>
  POST(new Request("http://localhost/api/automation-sessions", { method: "POST", body, headers: { "Content-Type": "application/json" } }));
const get = (query: string) => GET(new Request(`http://localhost/api/automation-sessions${query}`));

async function greenhouseJob() {
  const jobId = await insertJob(admin, USER, {});
  const sourceId = await insertSource(admin, USER, { kind: "greenhouse", slug: "acme" });
  await insertPosting(admin, USER, jobId, sourceId, { externalId: "123" });
  return jobId;
}

describe("POST /api/automation-sessions", () => {
  it("creates a queued session and enqueues it", async () => {
    await insertProfile(admin, USER);
    const jobId = await greenhouseJob();
    const res = await post(JSON.stringify({ jobId }));
    expect(res.status).toBe(201);
    const { session } = await res.json();
    expect(session).toMatchObject({ jobId, status: "queued", portal: "greenhouse", formUrl: "https://job-boards.greenhouse.io/acme/jobs/123" });
    expect(enqueueAutofill).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), { sessionId: session.id, userId: USER });
  });

  it("maps validation and domain errors to 400/404/409/422", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post(JSON.stringify({ jobId: "x" }))).status).toBe(400);
    expect((await post(JSON.stringify({ jobId: "11111111-1111-4111-8111-111111111111" }))).status).toBe(404);
    const jobId = await greenhouseJob();
    expect((await post(JSON.stringify({ jobId }))).status).toBe(409); // no profile
    await insertProfile(admin, USER);
    const uploadJob = await insertJob(admin, USER, { title: "Analyst" });
    const unsupported = await post(JSON.stringify({ jobId: uploadJob }));
    expect(unsupported.status).toBe(422);
    expect((await unsupported.json()).reason).toBe("no_supported_posting");
    expect((await post(JSON.stringify({ jobId }))).status).toBe(201);
    expect((await post(JSON.stringify({ jobId }))).status).toBe(409); // session_active
  });

  it("answers 503 and marks the session failed when the queue is down", async () => {
    vi.mocked(enqueueAutofill).mockRejectedValue(new Error("queue unavailable"));
    await insertProfile(admin, USER);
    const jobId = await greenhouseJob();
    expect((await post(JSON.stringify({ jobId }))).status).toBe(503);
    const [row] = await admin`SELECT status, error_code FROM automation_sessions WHERE user_id = ${USER}`;
    expect(row).toEqual({ status: "failed", error_code: "enqueue_failed" });
  });
});

describe("GET /api/automation-sessions", () => {
  it("returns support, resume availability, the application id and sessions newest first", async () => {
    const jobId = await greenhouseJob();
    await insertGeneratedPdf(admin, USER, jobId, "resume");
    await insertAutomationSession(admin, USER, jobId, { status: "failed" });
    const body = await (await get(`?jobId=${jobId}`)).json();
    expect(body).toMatchObject({ support: { supported: true, portal: "greenhouse" }, resumeAvailable: true, applicationId: null });
    expect(body.sessions).toHaveLength(1);
  });

  it("400s without jobId and 404s an unknown or malformed one", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?jobId=abc")).status).toBe(404);
    expect((await get("?jobId=11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });
});
