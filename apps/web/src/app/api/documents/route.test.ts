// apps/web/src/app/api/documents/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb } from "../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../test/documentsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000da",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000da";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeDocumentsUser(admin, USER));
afterAll(async () => {
  await wipeDocumentsUser(admin, USER);
  await admin.end();
});

const { POST, GET } = await import("./route");
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/documents", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const list = (jobId: string) => GET(new Request(`http://localhost/api/documents?jobId=${jobId}`));

describe("POST /api/documents", () => {
  it("exports a resume PDF (201) and lists it with its source version", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document).toMatchObject({ kind: "resume", format: "pdf", sourceVersion: 2, downloadFilename: "Jane Doe - GitLab - Resume.pdf" });
    expect(document.downloadUrl).toBe(`/api/documents/${document.id}/download`);

    const listed = await (await list(jobId)).json();
    expect(listed.documents.map((d: { id: string }) => d.id)).toEqual([document.id]);
  });

  it("returns 409 profile_changed with its message", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    await admin`INSERT INTO skills (user_id, name, display_order) VALUES (${USER}, 'Rust', 0)`;
    const res = await post({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/profile changed/i);
    await admin`DELETE FROM skills WHERE user_id = ${USER}`;
  });

  it("reports sourceVersion from the reused row's own source, not the requested sourceId, when content de-dups across versions", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER); // version 2
    const [opt3] = await admin`
      INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                        added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
      SELECT user_id, job_id, career_goal_id, 3, source_profile_content_hash, selected_bullets,
             added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model
      FROM resume_optimizations WHERE id = ${optimizationId} RETURNING id`;

    const first = await post({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" });
    const firstBody = await first.json();
    expect(firstBody.document.sourceVersion).toBe(2);

    // Same profile, same selected bullets as version 2 -> identical rendered model -> the export for
    // version 3 de-dups onto the row already stored for version 2 (whose resumeOptimizationId is still
    // optimizationId, not opt3.id).
    const second = await post({ kind: "resume", jobId, sourceId: opt3.id, format: "pdf" });
    const secondBody = await second.json();
    expect(secondBody.document.id).toBe(firstBody.document.id);
    expect(secondBody.document.sourceVersion).toBe(2);

    const listed = await (await list(jobId)).json();
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0].sourceVersion).toBe(secondBody.document.sourceVersion);
  });

  it("returns 400 for a bad body, bad JSON, or a source of another job; 404 for an unknown job", async () => {
    const { optimizationId } = await seedResumeExport(admin, USER);
    expect((await post({ kind: "cover", jobId: optimizationId, sourceId: optimizationId, format: "pdf" })).status).toBe(400);
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ kind: "resume", jobId: optimizationId, sourceId: optimizationId, format: "pdf", extra: 1 })).status).toBe(400);
    const [other] = await admin`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                                VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    expect((await post({ kind: "resume", jobId: other.id, sourceId: optimizationId, format: "pdf" })).status).toBe(400);
    expect((await post({ kind: "resume", jobId: "33333333-3333-3333-3333-333333333333", sourceId: optimizationId, format: "pdf" })).status).toBe(404);
  });
});

describe("GET /api/documents", () => {
  it("returns 404 for a missing or non-UUID jobId and an empty list for a job without documents", async () => {
    expect((await GET(new Request("http://localhost/api/documents"))).status).toBe(404);
    expect((await list("not-a-uuid")).status).toBe(404);
    const { jobId } = await seedResumeExport(admin, USER);
    expect(await (await list(jobId)).json()).toEqual({ documents: [] });
  });
});
