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

const USER_A = "00000000-0000-0000-0000-000000000917";
const USER_B = "00000000-0000-0000-0000-000000000918";
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

async function insertApplication(userId: string, jobId: string | null, extra: { status?: string; terminalAt?: string | null } = {}) {
  const [row] = await adminSql`
    INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot, terminal_at)
    VALUES (${userId}, ${jobId}, 'Acme', 'Engineer', ${extra.status ?? "applied"}, now(), current_date, '{}'::jsonb,
            ${extra.terminalAt ?? null}::timestamptz)
    RETURNING id`;
  return row.id as string;
}

describe("applications + application_events — RLS and constraints", () => {
  it("isolates both tables by user_id", async () => {
    await wipe();
    const appId = await insertApplication(USER_A, await insertJob(USER_A));
    await adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, to_status)
                   VALUES (${USER_A}, ${appId}, 'status_change', now(), 'applied')`;
    for (const table of ["applications", "application_events"]) {
      const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      expect((asA as unknown as { n: number }[])[0].n, `${table} as A`).toBeGreaterThan(0);
      expect((asB as unknown as { n: number }[])[0].n, `${table} as B`).toBe(0);
    }
  });

  it("allows one application per ingested job but any number of external ones", async () => {
    await wipe();
    const jobId = await insertJob(USER_A);
    await insertApplication(USER_A, jobId);
    await expect(insertApplication(USER_A, jobId)).rejects.toThrow(/applications_user_job_uniq/);
    await insertApplication(USER_A, null);
    await insertApplication(USER_A, null);
  });

  it("requires terminal_at exactly when the status is terminal", async () => {
    await wipe();
    await expect(insertApplication(USER_A, null, { status: "rejected", terminalAt: null })).rejects.toThrow(/applications_terminal_at_matches_status/);
    await expect(insertApplication(USER_A, null, { status: "screening", terminalAt: new Date().toISOString() })).rejects.toThrow(/applications_terminal_at_matches_status/);
    await insertApplication(USER_A, null, { status: "rejected", terminalAt: new Date().toISOString() });
  });

  it("keeps the application with job_id NULL when its job is deleted", async () => {
    await wipe();
    const jobId = await insertJob(USER_A);
    const appId = await insertApplication(USER_A, jobId);
    await adminSql`DELETE FROM jobs WHERE id = ${jobId}`;
    const [row] = await adminSql`SELECT job_id, company_name FROM applications WHERE id = ${appId}`;
    expect(row).toMatchObject({ job_id: null, company_name: "Acme" });
  });

  it("requires to_status exactly for status_change events and a JSON object detail", async () => {
    await wipe();
    const appId = await insertApplication(USER_A, null);
    await expect(adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at)
                          VALUES (${USER_A}, ${appId}, 'status_change', now())`).rejects.toThrow(/application_events_status_fields_match_type/);
    await expect(adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, to_status)
                          VALUES (${USER_A}, ${appId}, 'note', now(), 'applied')`).rejects.toThrow(/application_events_status_fields_match_type/);
    await expect(adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, detail)
                          VALUES (${USER_A}, ${appId}, 'note', now(), '[]'::jsonb)`).rejects.toThrow(/application_events_detail_object/);
  });

  it("cascades events when the application is deleted", async () => {
    await wipe();
    const appId = await insertApplication(USER_A, null);
    await adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, detail)
                   VALUES (${USER_A}, ${appId}, 'note', now(), '{"text":"x"}'::jsonb)`;
    await adminSql`DELETE FROM applications WHERE id = ${appId}`;
    const [{ n }] = await adminSql`SELECT count(*)::int AS n FROM application_events WHERE application_id = ${appId}`;
    expect(n).toBe(0);
  });
});
