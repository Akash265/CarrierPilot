import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient, closeDbClient } from "./client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL);
const db = createDbClient({ DATABASE_URL: APP_URL });

const USER_A = "00000000-0000-0000-0000-0000000008a1";
const USER_B = "00000000-0000-0000-0000-0000000008a2";
const MIGRATION_LOCK = 7420001;

async function wipe() {
  await adminSql`DELETE FROM applications WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`;
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
  await closeDbClient(db);
});

async function insertJob(userId: string): Promise<string> {
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${userId}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  return job.id as string;
}

async function insertSession(userId: string, jobId: string, extra: { status?: string; endedAt?: string | null; applicationId?: string | null } = {}) {
  const [row] = await adminSql`
    INSERT INTO automation_sessions (user_id, job_id, portal, adapter_version, form_url, status, ended_at, application_id)
    VALUES (${userId}, ${jobId}, 'greenhouse', 'greenhouse-v1', 'https://job-boards.greenhouse.io/acme/jobs/1',
            ${extra.status ?? "queued"}, ${extra.endedAt ?? null}::timestamptz, ${extra.applicationId ?? null})
    RETURNING id`;
  return row.id as string;
}

const ENDED = () => new Date().toISOString();

describe("automation_sessions — RLS and constraints", () => {
  it("isolates rows by user_id", async () => {
    await wipe();
    await insertSession(USER_A, await insertJob(USER_A));
    const count = async (userId: string) =>
      ((await withUserContext(db, userId, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM automation_sessions`))) as unknown as { n: number }[])[0].n;
    expect(await count(USER_A)).toBe(1);
    expect(await count(USER_B)).toBe(0);
  });

  it("allows one active session per user, any number of ended ones", async () => {
    await wipe();
    const jobId = await insertJob(USER_A);
    await insertSession(USER_A, jobId, { status: "awaiting_user" });
    await expect(insertSession(USER_A, jobId)).rejects.toThrow(/automation_sessions_one_active_per_user/);
    await insertSession(USER_A, jobId, { status: "abandoned", endedAt: ENDED() });
    await insertSession(USER_A, jobId, { status: "failed", endedAt: ENDED() });
    await insertSession(USER_B, await insertJob(USER_B)); // another user is unaffected
  });

  it("requires ended_at exactly when the status is terminal", async () => {
    await wipe();
    const jobId = await insertJob(USER_A);
    await expect(insertSession(USER_A, jobId, { status: "needs_manual", endedAt: null })).rejects.toThrow(/automation_sessions_ended_at_matches_status/);
    await expect(insertSession(USER_A, jobId, { status: "filling", endedAt: ENDED() })).rejects.toThrow(/automation_sessions_ended_at_matches_status/);
  });

  it("links an application at most once and survives the application's deletion", async () => {
    await wipe();
    const jobId = await insertJob(USER_A);
    const [app] = await adminSql`
      INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot)
      VALUES (${USER_A}, ${jobId}, 'Acme', 'Engineer', 'applied', now(), current_date, '{}'::jsonb) RETURNING id`;
    const first = await insertSession(USER_A, jobId, { status: "submission_detected", endedAt: ENDED(), applicationId: app.id });
    await expect(insertSession(USER_A, jobId, { status: "abandoned", endedAt: ENDED(), applicationId: app.id })).rejects.toThrow(/automation_sessions_application_uniq/);
    await adminSql`DELETE FROM applications WHERE id = ${app.id}`;
    const [row] = await adminSql`SELECT application_id FROM automation_sessions WHERE id = ${first}`;
    expect(row.application_id).toBeNull();
  });

  it("cascades with the job and rejects a non-array audit", async () => {
    await wipe();
    const jobId = await insertJob(USER_A);
    const id = await insertSession(USER_A, jobId);
    await expect(adminSql`UPDATE automation_sessions SET field_audit = '{}'::jsonb WHERE id = ${id}`).rejects.toThrow(/automation_sessions_field_audit_array/);
    await adminSql`DELETE FROM jobs WHERE id = ${jobId}`;
    expect(await adminSql`SELECT 1 FROM automation_sessions WHERE id = ${id}`).toHaveLength(0);
  });
});
