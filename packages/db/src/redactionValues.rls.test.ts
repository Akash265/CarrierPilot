import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDbClient, closeDbClient } from "./client";
import { loadRedactionValues } from "./redactionValues";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL);
const db = createDbClient({ DATABASE_URL: APP_URL });

// Phase 11b test users (…0c01/…0c02), verified unused repo-wide on 2026-10-07.
const USER = "00000000-0000-0000-0000-000000000c01";
const OTHER = "00000000-0000-0000-0000-000000000c02";
const MIGRATION_LOCK = 7420001;

const wipe = () => adminSql`DELETE FROM candidate_profiles WHERE user_id IN (${USER}, ${OTHER})`;

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
});
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await adminSql.end();
  await closeDbClient(db);
});

describe("loadRedactionValues", () => {
  it("returns the user's identifying profile values, skipping nulls", async () => {
    await adminSql`
      INSERT INTO candidate_profiles (user_id, full_name, email, phone_number, address_line1, linkedin_url)
      VALUES (${USER}, 'Jane Doe', 'jane@example.com', '+44 7700 900123', NULL, 'https://linkedin.com/in/janedoe')`;
    expect((await loadRedactionValues(db, USER)).sort()).toEqual(
      ["+44 7700 900123", "Jane Doe", "https://linkedin.com/in/janedoe", "jane@example.com"].sort()
    );
  });

  it("returns [] when the user has no profile", async () => {
    expect(await loadRedactionValues(db, USER)).toEqual([]);
  });

  it("never returns another user's values (RLS)", async () => {
    await adminSql`INSERT INTO candidate_profiles (user_id, full_name, email) VALUES (${OTHER}, 'Bob Jones', 'bob@example.com')`;
    expect(await loadRedactionValues(db, USER)).toEqual([]);
  });
});
