import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertApplication } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b3",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b3";
const MISSING = "11111111-1111-4111-8111-111111111111";
let admin: postgres.Sql;
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET, PATCH, DELETE } = await import("./route");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: string) =>
  PATCH(new Request("http://localhost", { method: "PATCH", body, headers: { "Content-Type": "application/json" } }), ctx(id));

describe("/api/applications/[id]", () => {
  it("GET returns the application and its events, 404 for unknown or non-UUID ids", async () => {
    const id = await insertApplication(admin, USER, {});
    const body = await (await GET(new Request("http://localhost"), ctx(id))).json();
    expect(body.application).toMatchObject({ id, snapshotSummary: { matchOverall: 78, atsOverall: 82 } });
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["status_change"]);
    expect((await GET(new Request("http://localhost"), ctx(MISSING))).status).toBe(404);
    expect((await GET(new Request("http://localhost"), ctx("nope"))).status).toBe(404);
  });

  it("PATCH edits fields, 400s bad input, 404s unknown", async () => {
    const id = await insertApplication(admin, USER, {});
    const res = await patch(id, JSON.stringify({ recruiterName: "Sam", followUpAt: "2026-10-09" }));
    expect(res.status).toBe(200);
    expect((await res.json()).application).toMatchObject({ recruiterName: "Sam", followUpAt: "2026-10-09" });
    expect((await patch(id, JSON.stringify({}))).status).toBe(400);
    expect((await patch(id, JSON.stringify({ jobUrl: "ftp://x" }))).status).toBe(400);
    expect((await patch(MISSING, JSON.stringify({ notes: "x" }))).status).toBe(404);
  });

  it("DELETE removes it (204), then 404", async () => {
    const id = await insertApplication(admin, USER, {});
    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), ctx(id))).status).toBe(204);
    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), ctx(id))).status).toBe(404);
  });
});
