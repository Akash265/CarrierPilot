import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL);
const db = createDbClient({ DATABASE_URL: APP_URL });

const USER_A = "00000000-0000-0000-0000-000000000015";
const USER_B = "00000000-0000-0000-0000-000000000016";
const TABLES = ["cover_letters", "interview_preparations"] as const;
// Same lock id as every other suite's migrate(): parallel migrate() on an empty DB races.
const MIGRATION_LOCK = 7420001;

async function wipe() {
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`; // cascades both tables
}

beforeAll(async () => {
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adminSql.end();
});

const para = (role: string) => ({ role, text: role, supported: true, unsupportedReason: null, evidence: [] });
const PARAGRAPHS = JSON.stringify(["opening", "company", "evidence", "closing"].map(para));
const SECTIONS = JSON.stringify({ likelyQuestions: [], gapQuestions: [], talkingPoints: [], questionsToAsk: [] });

async function seedUserA(): Promise<{ jobId: string; letterId: string; prepId: string }> {
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  const [letter] = await adminSql`
    INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, paragraphs, requires_review, generation_model)
    VALUES (${USER_A}, ${job.id}, 1, 'generated', 'ok', ${PARAGRAPHS}::jsonb, false, 'm') RETURNING id`;
  const [prep] = await adminSql`
    INSERT INTO interview_preparations (user_id, job_id, version, research_status_snapshot, sections, gap_terms_snapshot,
                                        requires_review, source_profile_content_hash, generation_model)
    VALUES (${USER_A}, ${job.id}, 1, 'ok', ${SECTIONS}::jsonb, '[]'::jsonb, false, 'h', 'm') RETURNING id`;
  return { jobId: job.id, letterId: letter.id, prepId: prep.id };
}

describe("cover letter + interview prep tables — RLS", () => {
  it("isolates both tables by user_id", async () => {
    await wipe();
    await seedUserA();
    for (const table of TABLES) {
      const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      expect((asA as unknown as { n: number }[])[0].n, `${table} as A`).toBeGreaterThan(0);
      expect((asB as unknown as { n: number }[])[0].n, `${table} as B`).toBe(0);
    }
  });

  it("prevents user B from reading user A's rows by a known id", async () => {
    await wipe();
    const { letterId, prepId } = await seedUserA();
    expect(await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT id FROM cover_letters WHERE id = ${letterId}`))).toHaveLength(0);
    expect(await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT id FROM interview_preparations WHERE id = ${prepId}`))).toHaveLength(0);
  });

  it("rejects a cover letter with fewer than 4 or more than 5 paragraphs, or a non-array", async () => {
    await wipe();
    const { jobId } = await seedUserA();
    for (const bad of [JSON.stringify([para("opening")]), JSON.stringify(Array(6).fill(para("evidence"))), "{}"]) {
      await expect(adminSql`
        INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, paragraphs, requires_review)
        VALUES (${USER_A}, ${jobId}, 2, 'generated', 'ok', ${bad}::jsonb, false)`).rejects.toThrow(/cover_letters_paragraphs_four_or_five/);
    }
  });

  it("rejects interview prep sections that are not an object and gap terms that are not an array", async () => {
    await wipe();
    const { jobId } = await seedUserA();
    await expect(adminSql`
      INSERT INTO interview_preparations (user_id, job_id, version, research_status_snapshot, sections, gap_terms_snapshot,
                                          requires_review, source_profile_content_hash, generation_model)
      VALUES (${USER_A}, ${jobId}, 2, 'ok', '[]'::jsonb, '[]'::jsonb, false, 'h', 'm')`).rejects.toThrow(/interview_preparations_sections_object/);
    await expect(adminSql`
      INSERT INTO interview_preparations (user_id, job_id, version, research_status_snapshot, sections, gap_terms_snapshot,
                                          requires_review, source_profile_content_hash, generation_model)
      VALUES (${USER_A}, ${jobId}, 2, 'ok', ${SECTIONS}::jsonb, '{}'::jsonb, false, 'h', 'm')`).rejects.toThrow(/interview_preparations_gap_terms_array/);
  });

  it("enforces one version number per (user, job) in each table", async () => {
    await wipe();
    const { jobId } = await seedUserA();
    await expect(adminSql`
      INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, paragraphs, requires_review)
      VALUES (${USER_A}, ${jobId}, 1, 'user_edited', 'ok', ${PARAGRAPHS}::jsonb, false)`).rejects.toThrow(/cover_letters_user_job_version_uniq/);
  });
});
