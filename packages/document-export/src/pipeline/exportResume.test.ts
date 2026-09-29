import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { extractText } from "@ai-career/ai";
import { withUserContext } from "@ai-career/db";
import { buildResumeSnapshot, type AppliedBullet } from "@ai-career/resume-optimization";
import { GENERATED_DOCUMENTS_BUCKET, createStorageClient, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, insertOptimization, type TestDb } from "../testing/db";
import { exportResume } from "./exportResume";
import { DocumentExportError } from "../errors";

const USER = "00000000-0000-0000-0000-0000000000de";
const storage = testStorageClient();
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(async () => {
  const keys = await testDb.adminSql`SELECT object_key FROM generated_documents WHERE user_id = ${USER}`;
  for (const { object_key } of keys) await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, object_key).catch(() => {});
  await wipeUser(testDb.adminSql, USER);
  await testDb.close();
});
beforeEach(async () => {
  await wipeUser(testDb.adminSql, USER);
  // wipeUser only clears DB rows; each prior test's storeDocument call left a permanent object in
  // MinIO (by design -- a winner's upload is never deleted). Without this, the concurrency test below
  // sees earlier tests' orphaned objects under the same user prefix and fails deterministically, not
  // flakily (deviation from the brief's verbatim beforeEach: see report Fix/deviation note).
  for (const key of await listUserObjectKeys()) {
    await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, key).catch(() => {});
  }
});

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

async function listUserObjectKeys(): Promise<string[]> {
  const keys: string[] = [];
  for await (const obj of storage.listObjectsV2(GENERATED_DOCUMENTS_BUCKET, `${USER}/`, true)) keys.push((obj as { name: string }).name);
  return keys;
}

async function fixtureWithOptimization() {
  const { jobId, goalId, bulletIds } = await seedResumeFixture(testDb, USER);
  const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
  const optimizationId = await insertOptimization(testDb, USER, jobId, goalId, [
    { sourceFactId: bulletIds[1], sourceType: "work_experience_bullet", originalText: "Built B", optimizedText: "Built B with Go", changeType: "reworded", justification: "j" },
  ], contentHash);
  return { jobId, optimizationId };
}

const run = (jobId: string, optimizationId: string, format: "pdf" | "docx" = "pdf") =>
  exportResume(testDb.db, storage, { userId: USER, jobId, optimizationId, format });

describe("exportResume", () => {
  it("renders, stores and records a resume with the merge rules applied and no street address", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const doc = await run(jobId, optimizationId);

    expect(doc).toMatchObject({ jobId, kind: "resume", format: "pdf", resumeOptimizationId: optimizationId, applicationPitchId: null,
      rendererVersion: "1", downloadFilename: "Jane Doe - GitLab - Resume.pdf" });
    expect(doc.objectKey).toMatch(new RegExp(`^${USER}/[0-9a-f-]{36}\\.pdf$`));
    const text = (await extractText(await readAll(await getGeneratedDocument(storage, doc.objectKey)), "pdf")).replace(/\s+/g, " ");
    expect(text.indexOf("Built B with Go")).toBeLessThan(text.indexOf("Built A"));
    expect(text).not.toContain("Secret Street");
    expect(text).not.toContain("REJECTED CLAIM");
    expect(doc.byteSize).toBeGreaterThan(0);
  });

  it("returns the existing row for an identical export without uploading again", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const first = await run(jobId, optimizationId);
    const second = await run(jobId, optimizationId);
    expect(second.id).toBe(first.id);
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM generated_documents WHERE user_id = ${USER}`;
    expect(n).toBe(1);
    expect(await listUserObjectKeys()).toEqual([first.objectKey]);
  });

  it("stores PDF and DOCX as separate documents", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const pdf = await run(jobId, optimizationId, "pdf");
    const docx = await run(jobId, optimizationId, "docx");
    expect(docx.id).not.toBe(pdf.id);
    expect(docx.downloadFilename).toBe("Jane Doe - GitLab - Resume.docx");
    await expect(extractText(await readAll(await getGeneratedDocument(storage, docx.objectKey)), "docx")).resolves.toContain("Built B with Go");
  });

  it("two concurrent identical exports end with one row and no orphaned object", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const [a, b] = await Promise.all([run(jobId, optimizationId), run(jobId, optimizationId)]);
    expect(a.id).toBe(b.id);
    const rows = await testDb.adminSql`SELECT object_key FROM generated_documents WHERE user_id = ${USER}`;
    expect(rows).toHaveLength(1);
    expect(await listUserObjectKeys()).toEqual([rows[0].object_key]);
  });

  it("stores separate rows, each with its own jobId and company, for identical content exported under two different jobs", async () => {
    const { jobId: jobIdA, goalId, bulletIds } = await seedResumeFixture(testDb, USER);
    const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
    const selectedBullets: AppliedBullet[] = [
      { sourceFactId: bulletIds[1], sourceType: "work_experience_bullet", originalText: "Built B", optimizedText: "Built B with Go", changeType: "reworded", justification: "j" },
    ];
    const optimizationIdA = await insertOptimization(testDb, USER, jobIdA, goalId, selectedBullets, contentHash);
    const [jobB] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Backend Engineer', 'backend engineer', 'dh-b', now(), now()) RETURNING id`;
    const optimizationIdB = await insertOptimization(testDb, USER, jobB.id, goalId, selectedBullets, contentHash);

    // Same profile, same selected bullets -> the rendered DocumentModel (and therefore contentHash) is
    // byte-identical for both jobs; only job_id in the de-dup key keeps these as two distinct rows.
    const docA = await run(jobIdA, optimizationIdA);
    const docB = await run(jobB.id, optimizationIdB);

    expect(docA.id).not.toBe(docB.id);
    expect(docA.contentHash).toBe(docB.contentHash);
    expect(docA.jobId).toBe(jobIdA);
    expect(docB.jobId).toBe(jobB.id);
    expect(docA.downloadFilename).toBe("Jane Doe - GitLab - Resume.pdf");
    expect(docB.downloadFilename).toBe("Jane Doe - Acme - Resume.pdf");
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM generated_documents WHERE user_id = ${USER}`;
    expect(n).toBe(2);
  });

  it("refuses with storage_unavailable when the object store is unreachable, and writes no row", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const unreachableStorage = createStorageClient({ MINIO_ENDPOINT: "http://127.0.0.1:1", MINIO_ACCESS_KEY: "x", MINIO_SECRET_KEY: "x" });
    await expect(
      exportResume(testDb.db, unreachableStorage, { userId: USER, jobId, optimizationId, format: "pdf" })
    ).rejects.toMatchObject({ errorClass: "storage_unavailable" });
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM generated_documents WHERE user_id = ${USER}`;
    expect(n).toBe(0);
  });

  it("refuses with profile_changed when the profile changed after the optimization", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    await testDb.adminSql`INSERT INTO skills (user_id, name, display_order) VALUES (${USER}, 'Rust', 1)`;
    await expect(run(jobId, optimizationId)).rejects.toMatchObject({ errorClass: "profile_changed" });
  });

  it("refuses with source_mismatch for an optimization of another job", async () => {
    const { optimizationId } = await fixtureWithOptimization();
    const [other] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    await expect(run(other.id, optimizationId)).rejects.toMatchObject({ errorClass: "source_mismatch" });
  });

  it("refuses with job_not_found for an unknown job", async () => {
    const { optimizationId } = await fixtureWithOptimization();
    await expect(run("33333333-3333-3333-3333-333333333333", optimizationId)).rejects.toBeInstanceOf(DocumentExportError);
    await expect(run("33333333-3333-3333-3333-333333333333", optimizationId)).rejects.toMatchObject({ errorClass: "job_not_found" });
  });
});
