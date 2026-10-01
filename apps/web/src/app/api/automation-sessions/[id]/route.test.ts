import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertAutomationSession } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000008a8",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000008a8";
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
const { POST: CANCEL } = await import("./cancel/route");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new Request(`http://localhost/api/automation-sessions/${id}`), ctx(id));
const cancel = (id: string) => CANCEL(new Request(`http://localhost/api/automation-sessions/${id}/cancel`, { method: "POST" }), ctx(id));

describe("/api/automation-sessions/[id]", () => {
  it("returns a session, and 404s unknown or malformed ids", async () => {
    const id = await insertAutomationSession(admin, USER, await insertJob(admin, USER, {}), { status: "awaiting_user" });
    expect((await (await get(id)).json()).session).toMatchObject({ id, status: "awaiting_user" });
    expect((await get("nope")).status).toBe(404);
    expect((await get("11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });

  it("cancels a queued session at once, flags an active one, and 409s an ended one", async () => {
    const jobId = await insertJob(admin, USER, {});
    const queued = await insertAutomationSession(admin, USER, jobId);
    expect((await (await cancel(queued)).json()).session).toMatchObject({ status: "abandoned", errorCode: "cancelled" });
    expect((await cancel(queued)).status).toBe(409);
    const active = await insertAutomationSession(admin, USER, jobId, { status: "filling" });
    expect((await (await cancel(active)).json()).session).toMatchObject({ status: "filling", cancelRequested: true });
    expect((await cancel("11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });
});
