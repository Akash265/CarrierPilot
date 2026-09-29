import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { extractText } from "@ai-career/ai";
import { GENERATED_DOCUMENTS_BUCKET, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, type TestDb } from "../testing/db";
import { exportPitch } from "./exportPitch";

const USER = "00000000-0000-0000-0000-0000000000df";
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
  // Mirrors exportResume.test.ts: wipeUser only clears DB rows, and storeDocument's winner objects are
  // never deleted, so a prior test's upload would otherwise leak into this user's MinIO prefix.
  for (const key of await listUserObjectKeys()) {
    await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, key).catch(() => {});
  }
});

const bullet = (kind: string, text: string, supported: boolean | null) => ({ kind, text, supported, unsupportedReason: supported === false ? "cites no job requirement" : null, evidence: [] });

async function insertPitch(jobId: string, origin: "generated" | "user_edited", roleSupported: boolean | null) {
  const bullets = [bullet("company", "Company line.", origin === "generated" ? true : null), bullet("role", "Role line.", roleSupported), bullet("candidate", "Candidate line.", origin === "generated" ? true : null)];
  const [row] = await testDb.adminSql`
    INSERT INTO application_pitches (user_id, job_id, version, origin, research_status_snapshot, bullets, requires_review, generation_model)
    VALUES (${USER}, ${jobId}, 1, ${origin}, 'ok', ${JSON.stringify(bullets)}::jsonb, ${roleSupported === false}, ${origin === "generated" ? "m" : null})
    RETURNING id`;
  return row.id as string;
}

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

describe("exportPitch", () => {
  it("exports a fully supported generated pitch with title, name and the three bullets", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "generated", true);
    const doc = await exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "pdf" });
    expect(doc).toMatchObject({ kind: "pitch", applicationPitchId: pitchId, resumeOptimizationId: null, downloadFilename: "Jane Doe - GitLab - Pitch.pdf" });
    const text = (await extractText(await readAll(await getGeneratedDocument(storage, doc.objectKey)), "pdf")).replace(/\s+/g, " ");
    for (const s of ["Why I'm a fit for Backend Engineer at GitLab", "Jane Doe", "Company line.", "Role line.", "Candidate line."]) expect(text).toContain(s);
  });

  it("refuses a generated pitch with an unsupported bullet (pitch_unsupported)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "generated", false);
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "pdf" })).rejects.toMatchObject({ errorClass: "pitch_unsupported" });
  });

  it("allows a user_edited pitch (supported = null)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "user_edited", null);
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "docx" })).resolves.toMatchObject({ format: "docx" });
  });

  it("refuses a pitch from another job (source_mismatch) and a user without a profile (no_profile)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "generated", true);
    const [other] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId: other.id, pitchId, format: "pdf" })).rejects.toMatchObject({ errorClass: "source_mismatch" });
    await testDb.adminSql`DELETE FROM candidate_profiles WHERE user_id = ${USER}`;
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "pdf" })).rejects.toMatchObject({ errorClass: "no_profile" });
  });
});
