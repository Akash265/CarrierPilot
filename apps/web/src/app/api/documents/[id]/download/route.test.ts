// apps/web/src/app/api/documents/[id]/download/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb } from "../../../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../../../test/documentsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000dc",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000dc";
const OTHER = "00000000-0000-0000-0000-0000000000dd";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeDocumentsUser(admin, USER);
  await wipeDocumentsUser(admin, OTHER);
});
afterAll(async () => {
  await wipeDocumentsUser(admin, USER);
  await wipeDocumentsUser(admin, OTHER);
  await admin.end();
});

const { POST } = await import("../../route");
const { GET } = await import("./route");
const download = (id: string) => GET(new Request(`http://localhost/api/documents/${id}/download`), { params: Promise.resolve({ id }) });

describe("GET /api/documents/[id]/download", () => {
  it("streams the stored PDF with safe download headers", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const created = await POST(new Request("http://localhost/api/documents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" }),
    }));
    const { document } = await created.json();

    const res = await download(document.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Jane Doe - GitLab - Resume.pdf"; filename*=UTF-8''Jane%20Doe%20-%20GitLab%20-%20Resume.pdf`
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBe(document.byteSize);
  });

  it("returns 404 for a non-UUID id, an unknown id, and another user's document", async () => {
    expect((await download("nope")).status).toBe(404);
    expect((await download("33333333-3333-3333-3333-333333333333")).status).toBe(404);
    const [job] = await admin`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                              VALUES (${OTHER}, 'Acme', 'acme', 'Dev', 'dev', 'dh', now(), now()) RETURNING id`;
    const [doc] = await admin`INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
                              VALUES (${OTHER}, ${job.id}, 'resume', 'pdf', 'x/y.pdf', 10, 'h', '1', 'f.pdf') RETURNING id`;
    expect((await download(doc.id)).status).toBe(404);
  });
});
