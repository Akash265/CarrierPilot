import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";

// packages/applications/src/testing -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const MIGRATION_LOCK = 7420001;

export interface TestDb {
  adminSql: postgres.Sql;
  db: DbClient;
  close(): Promise<void>;
}

export async function openTestDb(): Promise<TestDb> {
  const adminSql = postgres(ADMIN_URL);
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
  const db = createDbClient({ DATABASE_URL: APP_URL });
  return {
    adminSql,
    db,
    close: async () => {
      await closeDbClient(db);
      await adminSql.end();
    },
  };
}

/** Scoped to one user: other suites share the database concurrently. Applications first (external ones do not cascade from jobs). */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM applications WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`; // cascades matches, postings, documents, optimizations, pitches, letters, preps
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
}

const PARAGRAPHS = JSON.stringify(
  ["opening", "company", "evidence", "closing"].map((role) => ({ role, text: role, supported: true, unsupportedReason: null, evidence: [] }))
);
const BULLETS = JSON.stringify(
  ["company", "role", "candidate"].map((kind) => ({ kind, text: kind, supported: true, unsupportedReason: null, evidence: [] }))
);
const SECTIONS = JSON.stringify({ likelyQuestions: [], gapQuestions: [], talkingPoints: [], questionsToAsk: [] });

export interface SeededJob {
  jobId: string;
  goalId: string;
  resumeId: string;
  pitchId: string;
  coverLetterId: string;
  prepId: string;
}

/** A job with a match, one of each generated artifact (resume v1 + ATS evaluation, pitch v1, letter v1, prep v1) and a posting URL. */
export async function seedJobWithDocuments(
  adminSql: postgres.Sql,
  userId: string,
  opts: { title?: string; companyName?: string } = {}
): Promise<SeededJob> {
  const title = opts.title ?? "Data Engineer";
  const companyName = opts.companyName ?? "Acme";
  const [goal] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${userId}, 'Data roles', 1, 'parsed', 'confirmed', false) RETURNING id`;
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, work_mode, salary_min, salary_max,
                      salary_currency, salary_period, posted_at, first_seen_at, last_verified_at)
    VALUES (${userId}, ${companyName}, ${companyName.toLowerCase()}, ${title}, ${title.toLowerCase()}, ${"dh-" + title}, 'remote',
            70000, 90000, 'EUR', 'year', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z', now())
    RETURNING id`;
  const [source] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config, enabled)
    VALUES (${userId}, 'upload', 'Upload', '{}'::jsonb, false) RETURNING id`;
  await adminSql`
    INSERT INTO job_postings (user_id, job_id, source_id, external_id, url, fingerprint, content_hash, normalized, status, first_seen_at, last_seen_at)
    VALUES (${userId}, ${job.id}, ${source.id}, ${"ext-" + job.id}, 'https://jobs.example/1', ${"fp-" + job.id}, 'h', '{}'::jsonb, 'open', now(), now())`;
  await adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, overall_score, skills_score, computed_at)
    VALUES (${userId}, ${job.id}, ${goal.id}, true, 78, 0.8, now())`;
  const [resume] = await adminSql`
    INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                      added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
    VALUES (${userId}, ${job.id}, ${goal.id}, 1, 'profile-hash', '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'm') RETURNING id`;
  await adminSql`
    INSERT INTO ats_evaluations (user_id, resume_optimization_id, required_keyword_coverage, preferred_keyword_coverage, semantic_similarity,
                                 factual_consistency, action_verb_score, machine_readability_score, overall_score, evaluator_version)
    VALUES (${userId}, ${resume.id}, 0.9, 0.5, 0.7, 1, 0.8, 1, 82, 'v1')`;
  const [pitch] = await adminSql`
    INSERT INTO application_pitches (user_id, job_id, version, origin, research_status_snapshot, bullets, requires_review, generation_model)
    VALUES (${userId}, ${job.id}, 1, 'generated', 'ok', ${BULLETS}::jsonb, false, 'm') RETURNING id`;
  const [letter] = await adminSql`
    INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, paragraphs, requires_review, generation_model)
    VALUES (${userId}, ${job.id}, 1, 'generated', 'ok', ${PARAGRAPHS}::jsonb, false, 'm') RETURNING id`;
  const [prep] = await adminSql`
    INSERT INTO interview_preparations (user_id, job_id, version, research_status_snapshot, sections, gap_terms_snapshot,
                                        requires_review, source_profile_content_hash, generation_model)
    VALUES (${userId}, ${job.id}, 1, 'ok', ${SECTIONS}::jsonb, '[]'::jsonb, false, 'h', 'm') RETURNING id`;
  return { jobId: job.id, goalId: goal.id, resumeId: resume.id, pitchId: pitch.id, coverLetterId: letter.id, prepId: prep.id };
}
