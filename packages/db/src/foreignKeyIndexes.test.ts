import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Phase 11c index audit (D181). Every foreign key needs an index whose leading columns are exactly its columns:
 * Postgres has no automatic one, so deleting or re-keying a parent row (the retention sweep deletes generated
 * documents; SET NULL / CASCADE follow) otherwise scans the whole child table. A composite index that starts with
 * user_id does not count -- the foreign-key check does not filter by user.
 */
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const adminSql = postgres(process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test");

// The lock every db test file takes around migrate(), so parallel files never migrate concurrently.
const MIGRATION_LOCK = 7420001;

beforeAll(async () => {
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
});

afterAll(async () => {
  await adminSql.end();
});

describe("foreign-key indexes", () => {
  it("every foreign key has an index led by exactly its columns", async () => {
    const missing = await adminSql<{ fk: string }[]>`
      SELECT c.conrelid::regclass::text || '(' || (
               SELECT string_agg(a.attname, ',' ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             ) || ')' AS fk
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
            AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey
        )
      ORDER BY 1`;
    expect(missing.map((r) => r.fk)).toEqual([]);
  });
});
