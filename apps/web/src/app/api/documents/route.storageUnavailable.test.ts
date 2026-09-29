// apps/web/src/app/api/documents/route.storageUnavailable.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb } from "../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../test/documentsDb";

// A separate file (and mock) from route.test.ts: MINIO_ENDPOINT points at a closed local port so every
// storage call fails with ECONNREFUSED, exercising storeDocument's storage_unavailable path (D84) end to
// end through the route, instead of only at the pipeline level (second review, fix round 2).
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000ea",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://127.0.0.1:1",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000ea";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeDocumentsUser(admin, USER));
afterAll(async () => {
  await wipeDocumentsUser(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");

describe("POST /api/documents (storage unreachable)", () => {
  it("returns 502 with the fixed storage_unavailable message when the upload fails", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await POST(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" }),
      })
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Document storage is unavailable. Try again.");
  });
});
