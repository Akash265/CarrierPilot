import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { createEditedCoverLetter, EditCoverLetterBodySchema } from "./createEditedCoverLetter";

const USER = "00000000-0000-0000-0000-000000000013";
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(async () => {
  await wipeUser(testDb.adminSql, USER);
  await testDb.close();
});
beforeEach(() => wipeUser(testDb.adminSql, USER));

const ev = { id: "p:1", kind: "profile", text: "Built A", sourceUrl: null };
async function seedLetter(roles: string[]): Promise<{ jobId: string; letterId: string }> {
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  const paragraphs = roles.map((role) => ({ role, text: `Model ${role}`, supported: role !== "closing", unsupportedReason: null, evidence: [ev] }));
  const [letter] = await testDb.adminSql`
    INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, paragraphs, requires_review, source_profile_content_hash, generation_model)
    VALUES (${USER}, ${job.id}, 1, 'generated', 'no_results', ${JSON.stringify(paragraphs)}::jsonb, true, 'h', 'm') RETURNING id`;
  return { jobId: job.id, letterId: letter.id };
}

describe("EditCoverLetterBodySchema", () => {
  it("accepts 4-5 non-empty paragraphs and rejects others", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    expect(EditCoverLetterBodySchema.safeParse({ baseVersionId: id, paragraphs: ["a", "b", "c", "d"] }).success).toBe(true);
    expect(EditCoverLetterBodySchema.safeParse({ baseVersionId: id, paragraphs: ["a", "b", "c"] }).success).toBe(false);
    expect(EditCoverLetterBodySchema.safeParse({ baseVersionId: id, paragraphs: ["a", " ", "c", "d"] }).success).toBe(false);
    expect(EditCoverLetterBodySchema.safeParse({ baseVersionId: id, paragraphs: ["a", "x".repeat(1201), "c", "d"] }).success).toBe(false);
    expect(EditCoverLetterBodySchema.safeParse({ baseVersionId: id, paragraphs: ["a", "b\u0000", "c", "d"] }).success).toBe(false);
    expect(EditCoverLetterBodySchema.safeParse({ baseVersionId: id, paragraphs: ["a", "b", "c", "d"], extra: 1 }).success).toBe(false);
  });
});

describe("createEditedCoverLetter", () => {
  it("creates the next user_edited version, copying roles, evidence and research snapshot", async () => {
    const { jobId, letterId } = await seedLetter(["opening", "company", "evidence", "closing"]);
    const row = await createEditedCoverLetter(testDb.db, USER, jobId, { baseVersionId: letterId, paragraphs: ["A", "B", "C", "D"] });
    expect(row).toMatchObject({
      version: 2, origin: "user_edited", parentCoverLetterId: letterId, researchStatusSnapshot: "no_results",
      requiresReview: false, sourceProfileContentHash: null, generationModel: null,
    });
    expect(row.paragraphs).toEqual([
      { role: "opening", text: "A", supported: null, unsupportedReason: null, evidence: [ev] },
      { role: "company", text: "B", supported: null, unsupportedReason: null, evidence: [ev] },
      { role: "evidence", text: "C", supported: null, unsupportedReason: null, evidence: [ev] },
      { role: "closing", text: "D", supported: null, unsupportedReason: null, evidence: [ev] },
    ]);
  });

  it("rejects a base from another job and a paragraph count that differs from the base", async () => {
    const { jobId, letterId } = await seedLetter(["opening", "company", "evidence", "evidence", "closing"]);
    const [other] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    await expect(createEditedCoverLetter(testDb.db, USER, other.id, { baseVersionId: letterId, paragraphs: ["A", "B", "C", "D", "E"] }))
      .rejects.toMatchObject({ errorClass: "base_not_found" });
    await expect(createEditedCoverLetter(testDb.db, USER, jobId, { baseVersionId: letterId, paragraphs: ["A", "B", "C", "D"] }))
      .rejects.toMatchObject({ errorClass: "paragraph_count_mismatch" });
  });
});
