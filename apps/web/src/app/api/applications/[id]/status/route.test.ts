import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertApplication } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b4",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b4";
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
const post = (id: string, body: string) =>
  POST(new Request("http://localhost", { method: "POST", body, headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id }) });

describe("POST /api/applications/[id]/status", () => {
  it("changes the status and sets terminalAt for a terminal status", async () => {
    const id = await insertApplication(admin, USER, {});
    const res = await post(id, JSON.stringify({ toStatus: "rejected", note: "Form email" }));
    expect(res.status).toBe(200);
    const { application } = await res.json();
    expect(application.status).toBe("rejected");
    expect(application.terminalAt).not.toBeNull();
  });

  it("409s the same status, 400s an unknown one, 404s an unknown application", async () => {
    const id = await insertApplication(admin, USER, {});
    expect((await post(id, JSON.stringify({ toStatus: "applied" }))).status).toBe(409);
    expect((await post(id, JSON.stringify({ toStatus: "ghosted" }))).status).toBe(400);
    expect((await post("11111111-1111-4111-8111-111111111111", JSON.stringify({ toStatus: "offer" }))).status).toBe(404);
  });
});
