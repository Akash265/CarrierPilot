import type postgres from "postgres";
import { createDbClient, closeDbClient, withUserContext } from "@ai-career/db";
import { buildResumeSnapshot } from "@ai-career/resume-optimization";
import { createStorageClient, GENERATED_DOCUMENTS_BUCKET } from "@ai-career/storage";

const APP_URL = process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";

/** Profile + one role/bullet + goal + job + a resume_optimizations row whose hash matches the current profile. */
export async function seedResumeExport(admin: postgres.Sql, userId: string): Promise<{ jobId: string; optimizationId: string }> {
  await admin`INSERT INTO candidate_profiles (user_id, full_name, email) VALUES (${userId}, 'Jane Doe', 'jane@example.com')`;
  const [exp] = await admin`INSERT INTO work_experiences (user_id, company, title, display_order) VALUES (${userId}, 'Globex', 'Engineer', 0) RETURNING id`;
  await admin`INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order) VALUES (${userId}, ${exp.id}, 'Built A', 0)`;
  const [goal] = await admin`INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
                             VALUES (${userId}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await admin`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                            VALUES (${userId}, 'GitLab', 'gitlab', 'Backend Engineer', 'backend engineer', 'dh', now(), now()) RETURNING id`;
  const db = createDbClient({ DATABASE_URL: APP_URL });
  try {
    const { contentHash } = await withUserContext(db, userId, (tx) => buildResumeSnapshot(tx));
    const [opt] = await admin`
      INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                        added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
      VALUES (${userId}, ${job.id}, ${goal.id}, 2, ${contentHash}, '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'm') RETURNING id`;
    return { jobId: job.id as string, optimizationId: opt.id as string };
  } finally {
    await closeDbClient(db);
  }
}

/** Also removes this user's stored objects so test runs do not accumulate files in MinIO. */
export async function wipeDocumentsUser(admin: postgres.Sql, userId: string): Promise<void> {
  const storage = createStorageClient({
    MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
    MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
    MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
  });
  const keys = await admin`SELECT object_key FROM generated_documents WHERE user_id = ${userId}`;
  for (const { object_key } of keys) await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, object_key).catch(() => {});
  await admin`DELETE FROM jobs WHERE user_id = ${userId}`;
  await admin`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await admin`DELETE FROM work_experience_bullets WHERE user_id = ${userId}`;
  await admin`DELETE FROM work_experiences WHERE user_id = ${userId}`;
  await admin`DELETE FROM candidate_profiles WHERE user_id = ${userId}`;
}
