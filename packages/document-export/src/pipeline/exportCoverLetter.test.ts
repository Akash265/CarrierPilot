import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { extractText } from "@ai-career/ai";
import { GENERATED_DOCUMENTS_BUCKET, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, type TestDb } from "../testing/db";
import { exportCoverLetter } from "./exportCoverLetter";

const USER = "00000000-0000-0000-0000-000000000017";
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
  // Mirrors exportPitch.test.ts: wipeUser only clears DB rows, and storeDocument's winner objects are
  // never deleted, so a prior test's upload would otherwise leak into this user's MinIO prefix.
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

const para = (role: string, text: string, supported: boolean | null) =>
  ({ role, text, supported, unsupportedReason: supported === false ? "cites no profile evidence" : null, evidence: [] });

async function insertLetter(jobId: string, origin: "generated" | "user_edited", evidenceSupported: boolean | null) {
  const s = origin === "generated" ? true : null;
  const paragraphs = [para("opening", "Opening line.", s), para("company", "Company line.", s), para("evidence", "Evidence line.", evidenceSupported), para("closing", "Closing line.", s)];
  const [row] = await testDb.adminSql`
    INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, paragraphs, requires_review, generation_model)
    VALUES (${USER}, ${jobId}, 1, ${origin}, 'ok', ${JSON.stringify(paragraphs)}::jsonb, ${evidenceSupported === false}, ${origin === "generated" ? "m" : null})
    RETURNING id`;
  return row.id as string;
}

describe("exportCoverLetter", () => {
  it("exports a supported generated cover letter with salutation, paragraphs and sign-off", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const coverLetterId = await insertLetter(jobId, "generated", true);
    const doc = await exportCoverLetter(testDb.db, storage, { userId: USER, jobId, coverLetterId, format: "pdf" });
    expect(doc).toMatchObject({ kind: "cover_letter", coverLetterId, applicationPitchId: null, downloadFilename: "Jane Doe - GitLab - Cover Letter.pdf" });
    const text = (await extractText(await readAll(await getGeneratedDocument(storage, doc.objectKey)), "pdf")).replace(/\s+/g, " ");
    for (const s of ["Application for Backend Engineer at GitLab", "Dear Hiring Manager,", "Opening line.", "Evidence line.", "Closing line.", "Sincerely,"]) expect(text).toContain(s);
  });

  it("refuses a generated letter with an unsupported paragraph but allows a user_edited one", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const bad = await insertLetter(jobId, "generated", false);
    await expect(exportCoverLetter(testDb.db, storage, { userId: USER, jobId, coverLetterId: bad, format: "pdf" })).rejects.toMatchObject({ errorClass: "cover_letter_unsupported" });
    await testDb.adminSql`DELETE FROM cover_letters WHERE id = ${bad}`;
    const edited = await insertLetter(jobId, "user_edited", null);
    await expect(exportCoverLetter(testDb.db, storage, { userId: USER, jobId, coverLetterId: edited, format: "docx" })).resolves.toMatchObject({ format: "docx" });
  });

  it("refuses a letter from another job (source_mismatch) and a user without a profile (no_profile)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const coverLetterId = await insertLetter(jobId, "generated", true);
    const [other] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    await expect(exportCoverLetter(testDb.db, storage, { userId: USER, jobId: other.id, coverLetterId, format: "pdf" })).rejects.toMatchObject({ errorClass: "source_mismatch" });
    await testDb.adminSql`DELETE FROM candidate_profiles WHERE user_id = ${USER}`;
    await expect(exportCoverLetter(testDb.db, storage, { userId: USER, jobId, coverLetterId, format: "pdf" })).rejects.toMatchObject({ errorClass: "no_profile" });
  });
});
