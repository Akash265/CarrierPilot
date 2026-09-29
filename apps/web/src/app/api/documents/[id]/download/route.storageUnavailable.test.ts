// apps/web/src/app/api/documents/[id]/download/route.storageUnavailable.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb } from "../../../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../../../test/documentsDb";

// A separate file (and mock) from route.test.ts, mirroring ../../route.storageUnavailable.test.ts:
// MINIO_ENDPOINT points at a closed local port so storage calls fail with ECONNREFUSED. This exercises
// HEAD's statGeneratedDocument preflight -- a row can exist in the DB while the object itself is
// unreachable, and HEAD must surface that as a 502 (the same fixed message as GET), not a false 200
// (second review, fix round 2, follow-up).
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000eb",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://127.0.0.1:1",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000eb";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeDocumentsUser(admin, USER));
afterAll(async () => {
  await wipeDocumentsUser(admin, USER);
  await admin.end();
});

const { HEAD } = await import("./route");
const headDownload = (id: string) =>
  HEAD(new Request(`http://localhost/api/documents/${id}/download`, { method: "HEAD" }), { params: Promise.resolve({ id }) });

describe("HEAD /api/documents/[id]/download (storage unreachable)", () => {
  it("returns 502 when the row exists but MinIO cannot be reached", async () => {
    const { jobId } = await seedResumeExport(admin, USER);
    // Insert the row directly (no real upload happened, and none can -- storage is unreachable in this
    // file's mock): HEAD only needs a row whose object_key nothing will ever satisfy.
    const [doc] = await admin`
      INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
      VALUES (${USER}, ${jobId}, 'resume', 'pdf', 'unreachable/x.pdf', 10, 'h', '1', 'f.pdf') RETURNING id`;

    const res = await headDownload(doc.id);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Document storage is unavailable. Try again.");
  });
});
