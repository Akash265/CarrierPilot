import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { extractText } from "@ai-career/ai";
import { GENERATED_DOCUMENTS_BUCKET, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, type TestDb } from "../testing/db";
import { exportInterviewPrep } from "./exportInterviewPrep";

const USER = "00000000-0000-0000-0000-000000000018";
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

const g = (supported: boolean) => ({ supported, unsupportedReason: supported ? null : "x", evidence: [] });
async function insertPrep(jobId: string, talkingPointSupported: boolean) {
  const sections = {
    likelyQuestions: [1, 2, 3, 4, 5].map((i) => ({ question: `Likely question ${i}?`, category: "technical", answerOutline: [`Outline ${i}`], ...g(true) })),
    gapQuestions: [{ question: "Kubernetes question?", requirementTerm: "Kubernetes", framing: "Framing text.", ...g(true) }],
    talkingPoints: [{ text: "Talking point one.", ...g(talkingPointSupported) }, { text: "Talking point two.", ...g(true) }, { text: "Talking point three.", ...g(true) }],
    questionsToAsk: [1, 2, 3].map((i) => ({ question: `Ask ${i}?`, ...g(true) })),
  };
  const [row] = await testDb.adminSql`
    INSERT INTO interview_preparations (user_id, job_id, version, research_status_snapshot, sections, gap_terms_snapshot,
                                        requires_review, source_profile_content_hash, generation_model)
    VALUES (${USER}, ${jobId}, 1, 'ok', ${JSON.stringify(sections)}::jsonb, '["Kubernetes"]'::jsonb, ${!talkingPointSupported}, 'h', 'm')
    RETURNING id`;
  return row.id as string;
}

describe("exportInterviewPrep", () => {
  it("exports every section, marking unsupported items as unverified instead of refusing", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const interviewPrepId = await insertPrep(jobId, false);
    const doc = await exportInterviewPrep(testDb.db, storage, { userId: USER, jobId, interviewPrepId, format: "pdf" });
    expect(doc).toMatchObject({ kind: "interview_prep", interviewPreparationId: interviewPrepId, downloadFilename: "Jane Doe - GitLab - Interview Prep.pdf" });
    const text = (await extractText(await readAll(await getGeneratedDocument(storage, doc.objectKey)), "pdf")).replace(/\s+/g, " ");
    for (const s of ["Interview preparation: Backend Engineer at GitLab", "Likely question 1?", "Outline 1", "Kubernetes question?", "Framing text.", "Talking point one. (unverified)", "Ask 3?"]) expect(text).toContain(s);
  });

  it("returns the same row id when the same version and format are exported twice", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const interviewPrepId = await insertPrep(jobId, true);
    const first = await exportInterviewPrep(testDb.db, storage, { userId: USER, jobId, interviewPrepId, format: "pdf" });
    const second = await exportInterviewPrep(testDb.db, storage, { userId: USER, jobId, interviewPrepId, format: "pdf" });
    expect(second.id).toBe(first.id);
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM generated_documents WHERE user_id = ${USER}`;
    expect(n).toBe(1);
  });

  it("refuses a pack from another job (source_mismatch)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const interviewPrepId = await insertPrep(jobId, true);
    const [other] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    await expect(exportInterviewPrep(testDb.db, storage, { userId: USER, jobId: other.id, interviewPrepId, format: "docx" })).rejects.toMatchObject({ errorClass: "source_mismatch" });
  });
});
