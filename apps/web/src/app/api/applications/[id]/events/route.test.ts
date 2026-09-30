import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertApplication } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b5",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b5";
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

describe("POST /api/applications/[id]/events", () => {
  it("logs an interview (201) and a snooze that moves the follow-up date", async () => {
    const id = await insertApplication(admin, USER, { followUpAt: "2026-10-01" });
    const res = await post(id, JSON.stringify({ type: "interview", detail: { round: 1, kind: "phone_screen", summary: "30 min" } }));
    expect(res.status).toBe(201);
    expect((await res.json()).event).toMatchObject({ type: "interview", detail: { round: 1, kind: "phone_screen" } });
    expect((await post(id, JSON.stringify({ type: "follow_up_snoozed", detail: { newFollowUpAt: "2026-10-08" } }))).status).toBe(201);
    const [row] = await admin`SELECT follow_up_at::text AS f FROM applications WHERE id = ${id}`;
    expect(row.f).toBe("2026-10-08");
  });

  it("400s system-only types, 404s unknown applications", async () => {
    const id = await insertApplication(admin, USER, {});
    expect((await post(id, JSON.stringify({ type: "status_change", detail: {} }))).status).toBe(400);
    expect((await post("11111111-1111-4111-8111-111111111111", JSON.stringify({ type: "note", detail: { text: "x" } }))).status).toBe(404);
  });
});
