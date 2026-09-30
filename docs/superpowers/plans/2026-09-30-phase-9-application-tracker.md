# Phase 9 — Application Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tracker for every job application: lifecycle status with an append-only event log, the documents actually sent, follow-ups, a feature snapshot for Phase 10, "already applied" exclusion from matching, and a daily retention sweep.

**Architecture:** A new domain package `packages/applications` holds pure rules (status, event schemas, snapshot, retention planning) and thin DB operations run under `withUserContext` (RLS). Next.js routes under `/api/applications` only validate and call the package. A new `services/maintenance-worker` runs the retention sweep daily via a BullMQ job scheduler, and `pnpm retention:run` runs it once.

**Tech Stack:** TypeScript, Drizzle ORM 0.36 + drizzle-kit 0.28 (Postgres 16), Zod 3.24, Next.js 16 (App Router), React 19, BullMQ 5, MinIO JS client 8, Vitest 2, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-30-phase-9-application-tracker-design.md`

## Global Constraints

- Every user-scoped table has `user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid`, RLS enabled, and policy `user_isolation USING (user_id = current_setting('app.current_user_id')::uuid)`.
- All app-runtime DB access goes through `withUserContext(db, userId, fn)` from `@ai-career/db`. Admin/superuser SQL is only for tests (seed, inspect, wipe).
- Statuses: `applied, screening, interviewing, offer, accepted, declined, rejected, withdrawn, no_response`. Terminal: `accepted, declined, rejected, withdrawn, no_response`.
- Event types: `status_change, note, recruiter_contact, interview, follow_up_done, follow_up_snoozed, documents_purged`. Only the middle five are user-postable.
- Text caps: company 200, title 300, URL 2000 (http/https only), recruiter name 200, recruiter contact 300, salary notes 500, notes 5000, event text/summary 5000/2000.
- `feature_snapshot` is written once at creation and never updated.
- `terminal_at` is set to **now** (not the backdated `occurredAt`) when entering a terminal status, kept on terminal→terminal, and cleared on a non-terminal status.
- `RETENTION_DAYS` is an env integer ≥ 0, default 30; `0` disables the whole sweep. The orphan-object minimum age is 24h.
- The retention purge deletes rows first (one transaction per application, `FOR UPDATE SKIP LOCKED`) and MinIO objects **after** commit.
- Logs carry ids, counts and error classes only, never notes, recruiter details or document text (CLAUDE.md §9).
- HTTP mapping: 400 validation, 404 unknown or non-UUID id, 409 already applied or same status, 422 document not for this job.
- Do not commit `.env`. Commit after each task with the message given in its last step, ending with the session's Co-Authored-By/Claude-Session trailer lines.
- Local services must be up for tests: `docker compose -f infra/docker-compose.yml up -d` (postgres, redis, minio). If Docker is down: `open -a Docker` first.

---

## File Structure

**DB (`packages/db`)**
- Create `src/schema/applications.ts`: `applicationStatusEnum`, `applications` table.
- Create `src/schema/applicationEvents.ts`: `applicationEventTypeEnum`, `applicationEvents` table.
- Modify `src/schema/index.ts`: export both.
- Create `migrations/0024_<generated>.sql` (drizzle-kit) and `migrations/0025_applications_rls.sql` (custom: RLS + partial unique index).
- Modify `package.json`: `db:generate:custom:applications-rls` script.
- Create `src/applicationTables.rls.test.ts`.

**Config / storage**
- Modify `packages/config/src/env.ts` (+ `env.test.ts`): `RETENTION_DAYS`.
- Modify `packages/storage/src/generatedDocumentStorage.ts` (+ test, `index.ts`): `listGeneratedDocuments`.

**Domain (`packages/applications`, new)**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`.
- `src/types.ts`: row types, status and event-type constants.
- `src/errors.ts`: `ApplicationError`.
- `src/status.ts`: `isTerminal`, `planStatusChange`.
- `src/bodies.ts`: Zod request schemas (create, update, status, user events).
- `src/snapshot.ts`: `buildFeatureSnapshot`.
- `src/documentLinks.ts`: `loadLinkedDocuments` (same-job validation + snapshot refs).
- `src/createApplication.ts`: `createApplication`.
- `src/readApplications.ts`: `getApplication`, `listApplications`, `getApplicationForJob`, `listDocumentOptions`.
- `src/mutateApplication.ts`: `changeStatus`, `addEvent`, `updateApplication`, `deleteApplication`.
- `src/retention/planRetention.ts`: `isDueForPurge`, `planRetention`, `planOrphanSweep`.
- `src/retention/runRetentionSweep.ts`: `runRetentionSweep`.
- `src/testing/db.ts`, `src/testing/index.ts`: `openTestDb`, `wipeUser`, seed helpers.
- `src/index.ts`: public exports.

**Matching (`packages/matching`)**
- Modify `src/eligibility/evaluateEligibility.ts` (+ test): `alreadyApplied`.
- Modify `src/pipeline/runMatching.ts` (+ test): load applied job ids.
- Modify `src/testing/db.ts`: wipe applications.

**Worker (`services/maintenance-worker`, new)**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`.
- `src/queue.ts`, `src/storageAdapter.ts`, `src/worker.ts` (+ test), `src/main.ts`, `src/runOnce.ts`.
- Root `package.json`: `retention:run` script.

**Web (`apps/web`)**
- Modify `package.json`: depend on `@ai-career/applications`.
- Create `src/lib/applications/serializeApplication.ts` (+ test), `src/lib/applications/errorResponse.ts`, `src/lib/applications/statusLabels.ts` (+ test).
- Create routes `src/app/api/applications/route.ts`, `[id]/route.ts`, `[id]/status/route.ts`, `[id]/events/route.ts`, `for-job/[jobId]/route.ts` (+ tests).
- Modify `src/app/api/matches/[jobId]/route.ts`: add `applicationId`.
- Modify `src/test/jobsDb.ts`: `insertApplication`, wipe applications.
- Create `src/app/matches/[jobId]/ApplicationPanel.tsx` (+ test). Modify `MatchDetailClient.tsx` (+ test).
- Create `src/app/applications/page.tsx`, `ApplicationsClient.tsx` (+ test), `ExternalApplicationForm.tsx`.
- Create `src/app/applications/[id]/page.tsx`, `ApplicationDetailClient.tsx` (+ test), `EventTimeline.tsx`, `LogEventForm.tsx`, `EditApplicationForm.tsx`.
- Modify `src/app/page.tsx` (+ `page.test.tsx`): nav step 6.

**Docs**: `DECISIONS.md`, `FLOW.md`, `docs/architecture.md`, `README.md`, `.env.example`, spec §11 as-built.

---

### Task 1: Database tables, migrations and RLS

**Files:**
- Create: `packages/db/src/schema/applications.ts`, `packages/db/src/schema/applicationEvents.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/db/package.json`
- Create: `packages/db/migrations/0024_*.sql` (generated), `packages/db/migrations/0025_applications_rls.sql` (custom)
- Test: `packages/db/src/applicationTables.rls.test.ts`

**Interfaces:**
- Produces: `schema.applications`, `schema.applicationEvents`, `schema.applicationStatusEnum`, `schema.applicationEventTypeEnum` (Drizzle). Column property names: `id, userId, jobId, companyName, jobTitle, jobUrl, status, statusChangedAt, appliedAt (string YYYY-MM-DD), followUpAt (string|null), recruiterName, recruiterContact, salaryNotes, notes, resumeOptimizationId, applicationPitchId, coverLetterId, featureSnapshot, terminalAt, retentionPurgedAt, createdAt, updatedAt`; events: `id, userId, applicationId, type, occurredAt, fromStatus, toStatus, detail, createdAt`.

- [ ] **Step 1: Write the schema files**

`packages/db/src/schema/applications.ts`:
```ts
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, date, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { resumeOptimizations } from "./resumeOptimizations";
import { applicationPitches } from "./applicationPitches";
import { coverLetters } from "./coverLetters";

export const applicationStatusEnum = pgEnum("application_status", [
  "applied", "screening", "interviewing", "offer", "accepted", "declined", "rejected", "withdrawn", "no_response",
]);

/**
 * Phase 9 design §3. One row per application -- to an ingested job (job_id set) or an external one
 * (job_id null, company/title typed in). company_name/job_title are always filled so the tracker never
 * depends on the job row still existing (job delete -> SET NULL). The partial unique index
 * (user_id, job_id) WHERE job_id IS NOT NULL lives in the custom migration 0025, like 0010's partial index.
 * feature_snapshot is written once at creation (Phase 10 input) and never updated.
 * terminal_at is the retention clock: set when the status becomes terminal, cleared on reopen.
 */
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    companyName: text("company_name").notNull(),
    jobTitle: text("job_title").notNull(),
    jobUrl: text("job_url"),
    status: applicationStatusEnum("status").notNull().default("applied"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull(),
    appliedAt: date("applied_at", { mode: "string" }).notNull(),
    followUpAt: date("follow_up_at", { mode: "string" }),
    recruiterName: text("recruiter_name"),
    recruiterContact: text("recruiter_contact"),
    salaryNotes: text("salary_notes"),
    notes: text("notes"),
    resumeOptimizationId: uuid("resume_optimization_id").references(() => resumeOptimizations.id, { onDelete: "set null" }),
    applicationPitchId: uuid("application_pitch_id").references(() => applicationPitches.id, { onDelete: "set null" }),
    coverLetterId: uuid("cover_letter_id").references(() => coverLetters.id, { onDelete: "set null" }),
    featureSnapshot: jsonb("feature_snapshot").notNull(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    retentionPurgedAt: timestamp("retention_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userFollowUpIdx: index("applications_user_follow_up_idx").on(t.userId, t.followUpAt),
    userStatusIdx: index("applications_user_status_idx").on(t.userId, t.status),
    snapshotIsObject: check("applications_feature_snapshot_object", sql`jsonb_typeof(${t.featureSnapshot}) = 'object'`),
    // status::text, not a bare enum literal: same one-transaction migrator caveat as generated_documents.
    terminalAtMatchesStatus: check(
      "applications_terminal_at_matches_status",
      sql`(${t.status}::text IN ('accepted', 'declined', 'rejected', 'withdrawn', 'no_response')) = (${t.terminalAt} IS NOT NULL)`
    ),
    namesNotBlank: check(
      "applications_names_not_blank",
      sql`char_length(btrim(${t.companyName})) > 0 AND char_length(btrim(${t.jobTitle})) > 0`
    ),
  })
);
```

`packages/db/src/schema/applicationEvents.ts`:
```ts
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { applications, applicationStatusEnum } from "./applications";

export const applicationEventTypeEnum = pgEnum("application_event_type", [
  "status_change", "note", "recruiter_contact", "interview", "follow_up_done", "follow_up_snoozed", "documents_purged",
]);

/**
 * Phase 9 design §3. Append-only: application code never updates or deletes a row; only the
 * applications cascade removes them. detail is validated per type by packages/applications (Zod).
 * to_status is required exactly for status_change (from_status is null on the creation event).
 */
export const applicationEvents = pgTable(
  "application_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    type: applicationEventTypeEnum("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    fromStatus: applicationStatusEnum("from_status"),
    toStatus: applicationStatusEnum("to_status"),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    applicationOccurredIdx: index("application_events_application_occurred_idx").on(t.applicationId, t.occurredAt),
    detailIsObject: check("application_events_detail_object", sql`jsonb_typeof(${t.detail}) = 'object'`),
    statusFieldsMatchType: check(
      "application_events_status_fields_match_type",
      sql`(${t.type}::text = 'status_change') = (${t.toStatus} IS NOT NULL)
        AND (${t.fromStatus} IS NULL OR ${t.type}::text = 'status_change')`
    ),
  })
);
```

Append to `packages/db/src/schema/index.ts`:
```ts
export * from "./applications";
export * from "./applicationEvents";
```

Add to `packages/db/package.json` scripts, after the cover-letter one:
```json
"db:generate:custom:applications-rls": "dotenv -e ../../.env -- drizzle-kit generate --custom --name=applications_rls",
```

- [ ] **Step 2: Generate the migrations**

Run: `pnpm --filter @ai-career/db db:generate`
Expected: a new `packages/db/migrations/0024_<random_name>.sql` creating both enums, both tables, FKs, indexes and CHECKs. Open it and confirm it contains nothing unrelated (no changes to other tables).

Run: `pnpm --filter @ai-career/db db:generate:custom:applications-rls`
Expected: an empty `packages/db/migrations/0025_applications_rls.sql`. Replace its contents with:
```sql
-- Custom SQL migration: RLS + partial unique index for the Phase 9 tables. Follows 0023 and 0010.

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON applications
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE application_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON application_events
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- One application per ingested job; external applications (job_id NULL) are unconstrained.
CREATE UNIQUE INDEX applications_user_job_uniq ON applications (user_id, job_id) WHERE job_id IS NOT NULL;
```

- [ ] **Step 3: Write the failing RLS/constraint test**

`packages/db/src/applicationTables.rls.test.ts`:
```ts
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
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @ai-career/db test -- applicationTables`
Expected: PASS (6 tests). If it fails with "relation applications does not exist", the migrations were not generated into `packages/db/migrations`. Fix Step 2.

- [ ] **Step 5: Run the whole db package suite and typecheck**

Run: `pnpm --filter @ai-career/db test && pnpm --filter @ai-career/db typecheck && pnpm --filter @ai-career/db lint`
Expected: all green.

- [ ] **Step 6: Migrate the dev DB and commit**

Run: `pnpm --filter @ai-career/db db:migrate`
```bash
git add packages/db
git commit -m "feat(db): applications and application_events tables with RLS (Phase 9)"
```

---

### Task 2: `packages/applications` scaffold, status rules, request schemas

**Files:**
- Create: `packages/applications/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
- Create: `packages/applications/src/types.ts`, `src/errors.ts`, `src/status.ts`, `src/bodies.ts`, `src/index.ts`
- Test: `packages/applications/src/status.test.ts`, `src/bodies.test.ts`

**Interfaces:**
- Consumes: `schema.applicationStatusEnum.enumValues`, `schema.applicationEventTypeEnum.enumValues` (Task 1).
- Produces:
  - `type ApplicationRow`, `type ApplicationEventRow`, `APPLICATION_STATUSES`, `type ApplicationStatus`, `TERMINAL_STATUSES`, `type ApplicationEventType`
  - `class ApplicationError { errorClass: ApplicationErrorClass }` with `ApplicationErrorClass = "job_not_found" | "already_applied" | "document_mismatch" | "not_found" | "same_status"`
  - `isTerminal(s): boolean`, `planStatusChange(input: StatusChangeInput): StatusChangePlan`
  - `CreateApplicationBodySchema`/`CreateApplicationBody`, `UpdateApplicationBodySchema`/`UpdateApplicationBody`, `ChangeStatusBodySchema`/`ChangeStatusBody`, `UserEventBodySchema`/`UserEventBody`, `DateOnlySchema`, `todayUtc(now: Date): string`

- [ ] **Step 1: Scaffold the package**

`packages/applications/package.json`:
```json
{
  "name": "@ai-career/applications",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/db": "workspace:*",
    "drizzle-orm": "^0.36.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/applications/tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`packages/applications/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests migrate and share the test database, same reason as packages/application-package.
    fileParallelism: false,
  },
});
```

`packages/applications/eslint.config.mjs`:
```js
import baseConfig from "../../eslint.config.base.mjs";

export default baseConfig;
```

Run: `pnpm install`
Expected: the lockfile gains `packages/applications`; no other changes.

- [ ] **Step 2: Write `types.ts` and `errors.ts`**

`packages/applications/src/types.ts`:
```ts
import { schema } from "@ai-career/db";

export type ApplicationRow = typeof schema.applications.$inferSelect;
export type ApplicationEventRow = typeof schema.applicationEvents.$inferSelect;

/** Single source of truth: the Postgres enum's values. */
export const APPLICATION_STATUSES = schema.applicationStatusEnum.enumValues;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const TERMINAL_STATUSES = ["accepted", "declined", "rejected", "withdrawn", "no_response"] as const satisfies readonly ApplicationStatus[];

export const APPLICATION_EVENT_TYPES = schema.applicationEventTypeEnum.enumValues;
export type ApplicationEventType = (typeof APPLICATION_EVENT_TYPES)[number];
```

`packages/applications/src/errors.ts`:
```ts
export type ApplicationErrorClass = "job_not_found" | "already_applied" | "document_mismatch" | "not_found" | "same_status";

/** Carries a class only -- never user text -- so it is safe to log (CLAUDE.md §9). */
export class ApplicationError extends Error {
  readonly errorClass: ApplicationErrorClass;
  constructor(errorClass: ApplicationErrorClass) {
    super(errorClass);
    this.name = "ApplicationError";
    this.errorClass = errorClass;
  }
}
```

- [ ] **Step 3: Write the failing status test**

`packages/applications/src/status.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isTerminal, planStatusChange } from "./status";
import { ApplicationError } from "./errors";

const NOW = new Date("2026-10-01T12:00:00Z");
const EARLIER = new Date("2026-09-20T09:00:00Z");

describe("isTerminal", () => {
  it("is true only for the five terminal statuses", () => {
    expect(["accepted", "declined", "rejected", "withdrawn", "no_response"].every((s) => isTerminal(s as never))).toBe(true);
    expect(["applied", "screening", "interviewing", "offer"].some((s) => isTerminal(s as never))).toBe(false);
  });
});

describe("planStatusChange", () => {
  it("rejects a change to the same status", () => {
    expect(() => planStatusChange({ current: "applied", currentTerminalAt: null, to: "applied", now: NOW })).toThrow(ApplicationError);
  });

  it("allows any non-terminal move, including backwards, with no terminal clock", () => {
    expect(planStatusChange({ current: "offer", currentTerminalAt: null, to: "screening", now: NOW })).toEqual({
      status: "screening", statusChangedAt: NOW, terminalAt: null,
    });
  });

  it("starts the terminal clock at now even when the change is backdated", () => {
    expect(planStatusChange({ current: "interviewing", currentTerminalAt: null, to: "rejected", now: NOW, occurredAt: EARLIER })).toEqual({
      status: "rejected", statusChangedAt: EARLIER, terminalAt: NOW,
    });
  });

  it("keeps the original terminal clock on a terminal-to-terminal change", () => {
    expect(planStatusChange({ current: "rejected", currentTerminalAt: EARLIER, to: "withdrawn", now: NOW }).terminalAt).toEqual(EARLIER);
  });

  it("clears the terminal clock when reopening", () => {
    expect(planStatusChange({ current: "rejected", currentTerminalAt: EARLIER, to: "interviewing", now: NOW }).terminalAt).toBeNull();
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- status`
Expected: FAIL, "Cannot find module './status'".

- [ ] **Step 4: Implement `status.ts`**

```ts
import { ApplicationError } from "./errors";
import { TERMINAL_STATUSES, type ApplicationStatus } from "./types";

const TERMINAL = new Set<ApplicationStatus>(TERMINAL_STATUSES);

export const isTerminal = (status: ApplicationStatus): boolean => TERMINAL.has(status);

export interface StatusChangeInput {
  current: ApplicationStatus;
  currentTerminalAt: Date | null;
  to: ApplicationStatus;
  now: Date;
  /** User-supplied (may be backdated). Only affects statusChangedAt, never the retention clock. */
  occurredAt?: Date;
}

export interface StatusChangePlan {
  status: ApplicationStatus;
  statusChangedAt: Date;
  terminalAt: Date | null;
}

/**
 * Permissive lifecycle (design decision 2): any status may follow any other. The retention clock
 * (terminalAt) starts at `now`, not a backdated occurredAt, so recording an old rejection never makes
 * documents immediately purgeable; terminal -> terminal keeps the original clock.
 */
export function planStatusChange(input: StatusChangeInput): StatusChangePlan {
  if (input.to === input.current) throw new ApplicationError("same_status");
  const statusChangedAt = input.occurredAt ?? input.now;
  if (!isTerminal(input.to)) return { status: input.to, statusChangedAt, terminalAt: null };
  const keepClock = isTerminal(input.current) && input.currentTerminalAt !== null;
  return { status: input.to, statusChangedAt, terminalAt: keepClock ? input.currentTerminalAt : input.now };
}
```

Run: `pnpm --filter @ai-career/applications test -- status`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing request-schema test**

`packages/applications/src/bodies.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  CreateApplicationBodySchema, UpdateApplicationBodySchema, ChangeStatusBodySchema, UserEventBodySchema, DateOnlySchema, todayUtc,
} from "./bodies";

const JOB = "11111111-1111-4111-8111-111111111111";
const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

describe("DateOnlySchema / todayUtc", () => {
  it("accepts real YYYY-MM-DD dates only", () => {
    expect(DateOnlySchema.safeParse("2026-02-28").success).toBe(true);
    expect(DateOnlySchema.safeParse("2026-02-30").success).toBe(false);
    expect(DateOnlySchema.safeParse("28/02/2026").success).toBe(false);
  });
  it("formats the UTC date", () => {
    expect(todayUtc(new Date("2026-10-01T23:30:00Z"))).toBe("2026-10-01");
  });
});

describe("CreateApplicationBodySchema", () => {
  it("accepts an ingested job with document links", () => {
    expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, resumeOptimizationId: JOB, appliedAt: "2026-09-30" }).success).toBe(true);
  });
  it("accepts an external job and trims its text", () => {
    const r = CreateApplicationBodySchema.parse({ external: { companyName: "  Globex ", jobTitle: "Analyst", jobUrl: "https://globex.example/jobs/1" } });
    expect(r.external?.companyName).toBe("Globex");
  });
  it("requires exactly one of jobId and external", () => {
    expect(CreateApplicationBodySchema.safeParse({}).success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, external: { companyName: "A", jobTitle: "B" } }).success).toBe(false);
  });
  it("rejects document links on an external application", () => {
    expect(CreateApplicationBodySchema.safeParse({ external: { companyName: "A", jobTitle: "B" }, coverLetterId: JOB }).success).toBe(false);
  });
  it("rejects a non-http URL, a blank company and unknown keys", () => {
    expect(CreateApplicationBodySchema.safeParse({ external: { companyName: "A", jobTitle: "B", jobUrl: "javascript:alert(1)" } }).success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ external: { companyName: "  ", jobTitle: "B" } }).success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, featureSnapshot: {} }).success).toBe(false);
  });
});

describe("UpdateApplicationBodySchema", () => {
  it("accepts a partial edit and rejects an empty one", () => {
    expect(UpdateApplicationBodySchema.safeParse({ recruiterName: "Sam", followUpAt: null }).success).toBe(true);
    expect(UpdateApplicationBodySchema.safeParse({}).success).toBe(false);
  });
  it("rejects over-long notes", () => {
    expect(UpdateApplicationBodySchema.safeParse({ notes: "x".repeat(5001) }).success).toBe(false);
  });
});

describe("ChangeStatusBodySchema", () => {
  it("accepts a known status with an optional past occurredAt and note", () => {
    expect(ChangeStatusBodySchema.safeParse({ toStatus: "rejected", occurredAt: "2026-09-01T10:00:00Z", note: "Form email" }).success).toBe(true);
  });
  it("rejects an unknown status and a future occurredAt", () => {
    expect(ChangeStatusBodySchema.safeParse({ toStatus: "ghosted" }).success).toBe(false);
    expect(ChangeStatusBodySchema.safeParse({ toStatus: "rejected", occurredAt: future() }).success).toBe(false);
  });
});

describe("UserEventBodySchema", () => {
  it("accepts each user event type", () => {
    for (const body of [
      { type: "note", detail: { text: "Called back" } },
      { type: "recruiter_contact", detail: { channel: "linkedin", summary: "Intro" } },
      { type: "interview", detail: { round: 2, kind: "technical", scheduledFor: future() } },
      { type: "follow_up_done", detail: {} },
      { type: "follow_up_snoozed", detail: { newFollowUpAt: "2026-10-10" } },
    ]) {
      expect(UserEventBodySchema.safeParse(body).success, body.type).toBe(true);
    }
  });
  it("allows a future occurredAt only for interviews", () => {
    expect(UserEventBodySchema.safeParse({ type: "interview", occurredAt: future(), detail: { kind: "onsite" } }).success).toBe(true);
    expect(UserEventBodySchema.safeParse({ type: "note", occurredAt: future(), detail: { text: "x" } }).success).toBe(false);
  });
  it("rejects system-only types and bad details", () => {
    expect(UserEventBodySchema.safeParse({ type: "status_change", detail: {} }).success).toBe(false);
    expect(UserEventBodySchema.safeParse({ type: "documents_purged", detail: {} }).success).toBe(false);
    expect(UserEventBodySchema.safeParse({ type: "note", detail: { text: "" } }).success).toBe(false);
    expect(UserEventBodySchema.safeParse({ type: "recruiter_contact", detail: { channel: "fax" } }).success).toBe(false);
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- bodies`
Expected: FAIL, "Cannot find module './bodies'".

- [ ] **Step 6: Implement `bodies.ts`**

```ts
import { z } from "zod";
import { APPLICATION_STATUSES } from "./types";

/** Small clock-skew allowance for "not in the future" checks. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const notInFuture = (iso: string) => new Date(iso).getTime() <= Date.now() + FUTURE_TOLERANCE_MS;

/** Calendar dates are UTC YYYY-MM-DD strings (Drizzle `date` mode "string"). */
export const todayUtc = (now: Date): string => now.toISOString().slice(0, 10);

export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && todayUtc(d) === v;
  }, "Not a real calendar date");

const HttpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), "Must be an http(s) URL");

const OccurredAtSchema = z.string().datetime({ offset: true });
const Uuid = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const CompanyName = z.string().trim().min(1).max(200);
const JobTitle = z.string().trim().min(1).max(300);

const documentLinks = {
  resumeOptimizationId: Uuid.nullable().optional(),
  applicationPitchId: Uuid.nullable().optional(),
  coverLetterId: Uuid.nullable().optional(),
};

export const CreateApplicationBodySchema = z
  .object({
    jobId: Uuid.optional(),
    external: z.object({ companyName: CompanyName, jobTitle: JobTitle, jobUrl: HttpUrlSchema.nullable().optional() }).strict().optional(),
    ...documentLinks,
    appliedAt: DateOnlySchema.optional(),
    followUpAt: DateOnlySchema.nullable().optional(),
    notes: optionalText(5000),
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.jobId === undefined) === (body.external === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["jobId"], message: "Provide exactly one of jobId or external" });
    }
    if (body.external && (body.resumeOptimizationId || body.applicationPitchId || body.coverLetterId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["external"], message: "An external application cannot link generated documents" });
    }
  });
export type CreateApplicationBody = z.infer<typeof CreateApplicationBodySchema>;

export const UpdateApplicationBodySchema = z
  .object({
    companyName: CompanyName.optional(),
    jobTitle: JobTitle.optional(),
    jobUrl: HttpUrlSchema.nullable().optional(),
    appliedAt: DateOnlySchema.optional(),
    followUpAt: DateOnlySchema.nullable().optional(),
    recruiterName: optionalText(200),
    recruiterContact: optionalText(300),
    salaryNotes: optionalText(500),
    notes: optionalText(5000),
    ...documentLinks,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Nothing to update");
export type UpdateApplicationBody = z.infer<typeof UpdateApplicationBodySchema>;

export const ChangeStatusBodySchema = z
  .object({
    toStatus: z.enum(APPLICATION_STATUSES),
    occurredAt: OccurredAtSchema.refine(notInFuture, "Cannot be in the future").optional(),
    note: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();
export type ChangeStatusBody = z.infer<typeof ChangeStatusBodySchema>;

const Summary = z.string().trim().max(2000).default("");

export const UserEventBodySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("note"), occurredAt: OccurredAtSchema.optional(), detail: z.object({ text: z.string().trim().min(1).max(5000) }).strict() }).strict(),
    z.object({
      type: z.literal("recruiter_contact"),
      occurredAt: OccurredAtSchema.optional(),
      detail: z.object({ channel: z.enum(["email", "phone", "linkedin", "other"]), summary: Summary }).strict(),
    }).strict(),
    z.object({
      type: z.literal("interview"),
      occurredAt: OccurredAtSchema.optional(),
      detail: z.object({
        round: z.number().int().min(1).max(20).optional(),
        kind: z.enum(["phone_screen", "technical", "behavioral", "onsite", "panel", "other"]),
        scheduledFor: OccurredAtSchema.optional(),
        summary: Summary,
      }).strict(),
    }).strict(),
    z.object({ type: z.literal("follow_up_done"), occurredAt: OccurredAtSchema.optional(), detail: z.object({}).strict().default({}) }).strict(),
    z.object({ type: z.literal("follow_up_snoozed"), occurredAt: OccurredAtSchema.optional(), detail: z.object({ newFollowUpAt: DateOnlySchema }).strict() }).strict(),
  ])
  .superRefine((event, ctx) => {
    // An interview may be logged ahead of time; everything else records something that already happened.
    if (event.type !== "interview" && event.occurredAt && !notInFuture(event.occurredAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["occurredAt"], message: "Cannot be in the future" });
    }
  });
export type UserEventBody = z.infer<typeof UserEventBodySchema>;
```

Run: `pnpm --filter @ai-career/applications test -- bodies`
Expected: PASS.

- [ ] **Step 7: Write `index.ts`, typecheck, lint, commit**

`packages/applications/src/index.ts`:
```ts
export * from "./types";
export { ApplicationError, type ApplicationErrorClass } from "./errors";
export { isTerminal, planStatusChange, type StatusChangeInput, type StatusChangePlan } from "./status";
export {
  CreateApplicationBodySchema, UpdateApplicationBodySchema, ChangeStatusBodySchema, UserEventBodySchema, DateOnlySchema, todayUtc,
  type CreateApplicationBody, type UpdateApplicationBody, type ChangeStatusBody, type UserEventBody,
} from "./bodies";
```

Run: `pnpm --filter @ai-career/applications typecheck && pnpm --filter @ai-career/applications lint`
Expected: clean.

```bash
git add packages/applications pnpm-lock.yaml
git commit -m "feat(applications): package scaffold, status rules and request schemas"
```

---

### Task 3: Feature snapshot builder

**Files:**
- Create: `packages/applications/src/snapshot.ts`
- Modify: `packages/applications/src/index.ts`
- Test: `packages/applications/src/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `interface SnapshotJobInput`, `SnapshotMatchInput`, `SnapshotAtsInput`, `SnapshotDocumentRef`, `FeatureSnapshotV1`
  - `type BuildSnapshotInput`
  - `buildFeatureSnapshot(input: BuildSnapshotInput): FeatureSnapshotV1`

- [ ] **Step 1: Write the failing test**

`packages/applications/src/snapshot.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildFeatureSnapshot, type SnapshotJobInput, type SnapshotMatchInput } from "./snapshot";

const JOB: SnapshotJobInput = {
  title: "Data Engineer", companyName: "Acme", seniority: "senior", countryCode: "DE", locationRaw: "Berlin",
  workMode: "remote", employmentType: "full_time", salaryMin: "70000", salaryMax: "90000", salaryCurrency: "EUR",
  salaryPeriod: "year", sponsorship: "offered", postedAt: new Date("2026-09-20T08:00:00Z"), firstSeenAt: new Date("2026-09-21T00:00:00Z"),
};
const MATCH: SnapshotMatchInput = {
  careerGoalId: "g1", eligible: true, overallScore: "78", skillsScore: "0.8", experienceScore: "1", locationScore: "0.9",
  sponsorshipScore: "1", roleScore: "0.7", salaryScore: null, industryScore: "0.5", freshnessScore: "0.6", semanticScore: "0.66",
  computedAt: new Date("2026-09-29T00:00:00Z"),
};

describe("buildFeatureSnapshot", () => {
  it("records an ingested application's job, match, ATS and document refs as numbers", () => {
    const s = buildFeatureSnapshot({
      kind: "ingested", job: JOB, match: MATCH, appliedAt: "2026-09-30",
      ats: { overallScore: "82", requiredKeywordCoverage: "0.9", preferredKeywordCoverage: "0.5", semanticSimilarity: null },
      documents: {
        resume: { id: "r1", version: 3, origin: null, sourceProfileContentHash: "h" },
        pitch: { id: "p1", version: 2, origin: "user_edited", sourceProfileContentHash: null },
        coverLetter: null,
      },
    });
    expect(s).toEqual({
      snapshotVersion: 1,
      external: false,
      job: {
        title: "Data Engineer", companyName: "Acme", seniority: "senior", countryCode: "DE", locationRaw: "Berlin", workMode: "remote",
        employmentType: "full_time", salaryMin: 70000, salaryMax: 90000, salaryCurrency: "EUR", salaryPeriod: "year",
        sponsorship: "offered", postingAgeDays: 9,
      },
      match: {
        careerGoalId: "g1", eligible: true, overallScore: 78, skillsScore: 0.8, experienceScore: 1, locationScore: 0.9,
        sponsorshipScore: 1, roleScore: 0.7, salaryScore: null, industryScore: 0.5, freshnessScore: 0.6, semanticScore: 0.66,
        computedAt: "2026-09-29T00:00:00.000Z",
      },
      ats: { overallScore: 82, requiredKeywordCoverage: 0.9, preferredKeywordCoverage: 0.5, semanticSimilarity: null },
      documents: {
        resume: { id: "r1", version: 3, origin: null, sourceProfileContentHash: "h" },
        pitch: { id: "p1", version: 2, origin: "user_edited", sourceProfileContentHash: null },
        coverLetter: null,
      },
    });
  });

  it("uses firstSeenAt when postedAt is missing, never a negative age, and null (not zero) for missing parts", () => {
    const s = buildFeatureSnapshot({
      kind: "ingested", job: { ...JOB, postedAt: null, firstSeenAt: new Date("2026-10-02T00:00:00Z"), salaryMin: null },
      match: null, ats: null, documents: { resume: null, pitch: null, coverLetter: null }, appliedAt: "2026-09-30",
    });
    expect(s.job.postingAgeDays).toBe(0);
    expect(s.job.salaryMin).toBeNull();
    expect(s.match).toBeNull();
    expect(s.ats).toBeNull();
  });

  it("records an external application with only company and title", () => {
    const s = buildFeatureSnapshot({ kind: "external", companyName: "Globex", jobTitle: "Analyst" });
    expect(s.external).toBe(true);
    expect(s.job).toMatchObject({ companyName: "Globex", title: "Analyst", workMode: null, postingAgeDays: null });
    expect(s.match).toBeNull();
    expect(s.ats).toBeNull();
    expect(s.documents).toBeNull();
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- snapshot`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement `snapshot.ts`**

```ts
const MS_PER_DAY = 86_400_000;
const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** The jobs-table fields the snapshot reads (numeric columns arrive from Drizzle as strings). */
export interface SnapshotJobInput {
  title: string;
  companyName: string;
  seniority: string | null;
  countryCode: string | null;
  locationRaw: string | null;
  workMode: string;
  employmentType: string | null;
  salaryMin: string | null;
  salaryMax: string | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  sponsorship: string;
  postedAt: Date | null;
  firstSeenAt: Date;
}

export interface SnapshotMatchInput {
  careerGoalId: string;
  eligible: boolean;
  overallScore: string | null;
  skillsScore: string | null;
  experienceScore: string | null;
  locationScore: string | null;
  sponsorshipScore: string | null;
  roleScore: string | null;
  salaryScore: string | null;
  industryScore: string | null;
  freshnessScore: string | null;
  semanticScore: string | null;
  computedAt: Date;
}

export interface SnapshotAtsInput {
  overallScore: string;
  requiredKeywordCoverage: string;
  preferredKeywordCoverage: string;
  semanticSimilarity: string | null;
}

export interface SnapshotDocumentRef {
  id: string;
  version: number;
  /** generated / user_edited for pitch and cover letter; null for the resume optimization. */
  origin: "generated" | "user_edited" | null;
  sourceProfileContentHash: string | null;
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

export interface FeatureSnapshotV1 {
  snapshotVersion: 1;
  external: boolean;
  job: { title: string; companyName: string } & Nullable<{
    seniority: string; countryCode: string; locationRaw: string; workMode: string; employmentType: string;
    salaryMin: number; salaryMax: number; salaryCurrency: string; salaryPeriod: string; sponsorship: string; postingAgeDays: number;
  }>;
  match: {
    careerGoalId: string; eligible: boolean; computedAt: string;
    overallScore: number | null; skillsScore: number | null; experienceScore: number | null; locationScore: number | null;
    sponsorshipScore: number | null; roleScore: number | null; salaryScore: number | null; industryScore: number | null;
    freshnessScore: number | null; semanticScore: number | null;
  } | null;
  ats: { overallScore: number; requiredKeywordCoverage: number; preferredKeywordCoverage: number; semanticSimilarity: number | null } | null;
  documents: { resume: SnapshotDocumentRef | null; pitch: SnapshotDocumentRef | null; coverLetter: SnapshotDocumentRef | null } | null;
}

export type BuildSnapshotInput =
  | { kind: "external"; companyName: string; jobTitle: string }
  | {
      kind: "ingested";
      job: SnapshotJobInput;
      match: SnapshotMatchInput | null;
      ats: SnapshotAtsInput | null;
      documents: { resume: SnapshotDocumentRef | null; pitch: SnapshotDocumentRef | null; coverLetter: SnapshotDocumentRef | null };
      /** YYYY-MM-DD */
      appliedAt: string;
    };

/**
 * Phase 9 design §3: what was true when the user applied, for Phase 10. job_matches is overwritten on
 * every matching run and retention deletes the documents, so this is the only durable record. Missing
 * parts are null, never zero (a missing salary is not a salary of 0).
 */
export function buildFeatureSnapshot(input: BuildSnapshotInput): FeatureSnapshotV1 {
  if (input.kind === "external") {
    return {
      snapshotVersion: 1,
      external: true,
      job: {
        title: input.jobTitle, companyName: input.companyName, seniority: null, countryCode: null, locationRaw: null, workMode: null,
        employmentType: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, sponsorship: null, postingAgeDays: null,
      },
      match: null,
      ats: null,
      documents: null,
    };
  }

  const { job, match, ats } = input;
  const reference = job.postedAt ?? job.firstSeenAt;
  const appliedMs = Date.parse(`${input.appliedAt}T00:00:00Z`);
  const postingAgeDays = Math.max(0, Math.floor((appliedMs - reference.getTime()) / MS_PER_DAY));

  return {
    snapshotVersion: 1,
    external: false,
    job: {
      title: job.title, companyName: job.companyName, seniority: job.seniority, countryCode: job.countryCode, locationRaw: job.locationRaw,
      workMode: job.workMode, employmentType: job.employmentType, salaryMin: num(job.salaryMin), salaryMax: num(job.salaryMax),
      salaryCurrency: job.salaryCurrency, salaryPeriod: job.salaryPeriod, sponsorship: job.sponsorship, postingAgeDays,
    },
    match: match && {
      careerGoalId: match.careerGoalId, eligible: match.eligible, computedAt: match.computedAt.toISOString(),
      overallScore: num(match.overallScore), skillsScore: num(match.skillsScore), experienceScore: num(match.experienceScore),
      locationScore: num(match.locationScore), sponsorshipScore: num(match.sponsorshipScore), roleScore: num(match.roleScore),
      salaryScore: num(match.salaryScore), industryScore: num(match.industryScore), freshnessScore: num(match.freshnessScore),
      semanticScore: num(match.semanticScore),
    },
    ats: ats && {
      overallScore: Number(ats.overallScore), requiredKeywordCoverage: Number(ats.requiredKeywordCoverage),
      preferredKeywordCoverage: Number(ats.preferredKeywordCoverage), semanticSimilarity: num(ats.semanticSimilarity),
    },
    documents: input.documents,
  };
}
```

Run: `pnpm --filter @ai-career/applications test -- snapshot`
Expected: PASS (3 tests).

- [ ] **Step 3: Export, typecheck, commit**

Append to `packages/applications/src/index.ts`:
```ts
export {
  buildFeatureSnapshot,
  type BuildSnapshotInput, type FeatureSnapshotV1, type SnapshotJobInput, type SnapshotMatchInput, type SnapshotAtsInput, type SnapshotDocumentRef,
} from "./snapshot";
```

Run: `pnpm --filter @ai-career/applications typecheck`
```bash
git add packages/applications
git commit -m "feat(applications): feature snapshot builder"
```

---

### Task 4: Create and read applications (DB)

**Files:**
- Create: `packages/applications/src/testing/db.ts`, `src/testing/index.ts`
- Create: `packages/applications/src/documentLinks.ts`, `src/createApplication.ts`, `src/readApplications.ts`
- Modify: `packages/applications/src/index.ts`
- Test: `packages/applications/src/createApplication.test.ts`, `src/readApplications.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ApplicationError`, `CreateApplicationBody`, `todayUtc`, `ApplicationRow`), Task 3 (`buildFeatureSnapshot`, `SnapshotDocumentRef`, `SnapshotAtsInput`).
- Produces:
  - `loadLinkedDocuments(tx: DbClient, jobId: string, ids: DocumentLinkIds): Promise<LinkedDocuments>`, where `LinkedDocuments = { resume: SnapshotDocumentRef|null; pitch: SnapshotDocumentRef|null; coverLetter: SnapshotDocumentRef|null; ats: SnapshotAtsInput|null }`
  - `createApplication(db: DbClient, userId: string, body: CreateApplicationBody, now?: Date): Promise<ApplicationRow>`
  - `getApplication(db, userId, id): Promise<{ application: ApplicationRow; events: ApplicationEventRow[] } | null>`
  - `listApplications(db, userId, opts: { status?: ApplicationStatus; dueOnly?: boolean; today: string }): Promise<{ applications: ApplicationRow[]; dueCount: number }>`
  - `getApplicationForJob(db, userId, jobId): Promise<ApplicationRow | null>`
  - `listDocumentOptions(db, userId, jobId): Promise<DocumentOptions>`, where `DocumentOption = { id: string; version: number; origin: "generated"|"user_edited"|null }` and `DocumentOptions = { resumes; pitches; coverLetters }` (arrays, newest first)
  - Testing: `openTestDb(): Promise<TestDb>`, `wipeUser(adminSql, userId)`, `seedJobWithDocuments(adminSql, userId, opts?)`, returning `{ jobId, goalId, resumeId, pitchId, coverLetterId, prepId }`

- [ ] **Step 1: Write the testing helpers**

`packages/applications/src/testing/db.ts`:
```ts
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
```

`packages/applications/src/testing/index.ts`:
```ts
export { openTestDb, wipeUser, seedJobWithDocuments, type TestDb, type SeededJob } from "./db";
```

If any column name in the seed SQL differs from the actual schema (check `packages/db/src/schema/*.ts`), fix the seed to the real column name; do not change the schema.

- [ ] **Step 2: Write the failing create test**

`packages/applications/src/createApplication.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "./testing";
import { createApplication } from "./createApplication";
import { ApplicationError } from "./errors";

const USER = "00000000-0000-0000-0000-0000000009a1";
const NOW = new Date("2026-09-30T10:00:00Z");
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

const errorClassOf = (p: Promise<unknown>) =>
  p.then(() => "resolved", (e) => (e instanceof ApplicationError ? e.errorClass : `other:${String(e)}`));

describe("createApplication", () => {
  it("creates an ingested application with copied job fields, links, snapshot and an initial status event", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const row = await createApplication(t.db, USER, { jobId: s.jobId, resumeOptimizationId: s.resumeId, applicationPitchId: s.pitchId }, NOW);

    expect(row).toMatchObject({
      jobId: s.jobId, companyName: "Acme", jobTitle: "Data Engineer", jobUrl: "https://jobs.example/1", status: "applied",
      appliedAt: "2026-09-30", resumeOptimizationId: s.resumeId, applicationPitchId: s.pitchId, coverLetterId: null, terminalAt: null,
    });
    const snap = row.featureSnapshot as Record<string, any>;
    expect(snap.external).toBe(false);
    expect(snap.match).toMatchObject({ careerGoalId: s.goalId, overallScore: 78 });
    expect(snap.ats).toMatchObject({ overallScore: 82, requiredKeywordCoverage: 0.9 });
    expect(snap.documents.resume).toMatchObject({ id: s.resumeId, version: 1, sourceProfileContentHash: "profile-hash" });
    expect(snap.documents.pitch).toMatchObject({ id: s.pitchId, version: 1, origin: "generated" });
    expect(snap.job.postingAgeDays).toBe(10);

    const events = await t.adminSql`SELECT type, from_status, to_status FROM application_events WHERE application_id = ${row.id}`;
    expect(events).toEqual([{ type: "status_change", from_status: null, to_status: "applied" }]);
  });

  it("creates an external application with no job, typed-in fields and an external snapshot", async () => {
    const row = await createApplication(t.db, USER, { external: { companyName: "Globex", jobTitle: "Analyst", jobUrl: null }, appliedAt: "2026-09-28" }, NOW);
    expect(row).toMatchObject({ jobId: null, companyName: "Globex", jobTitle: "Analyst", appliedAt: "2026-09-28" });
    expect((row.featureSnapshot as { external: boolean }).external).toBe(true);
  });

  it("returns job_not_found for an unknown job", async () => {
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: "11111111-1111-4111-8111-111111111111" }, NOW))).toBe("job_not_found");
  });

  it("returns already_applied for a second application to the same job, and writes nothing", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await createApplication(t.db, USER, { jobId: s.jobId }, NOW);
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId }, NOW))).toBe("already_applied");
    const [{ n }] = await t.adminSql`SELECT count(*)::int AS n FROM application_events WHERE user_id = ${USER}`;
    expect(n).toBe(1);
  });

  it("returns document_mismatch when a linked document belongs to another job", async () => {
    const a = await seedJobWithDocuments(t.adminSql, USER, { title: "Data Engineer" });
    const b = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: a.jobId, coverLetterId: b.coverLetterId }, NOW))).toBe("document_mismatch");
  });

  it("cannot see another user's job", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    expect(await errorClassOf(createApplication(t.db, "00000000-0000-0000-0000-0000000009a2", { jobId: s.jobId }, NOW))).toBe("job_not_found");
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- createApplication`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `documentLinks.ts` and `createApplication.ts`**

`packages/applications/src/documentLinks.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import type { SnapshotAtsInput, SnapshotDocumentRef } from "./snapshot";

const { resumeOptimizations, atsEvaluations, applicationPitches, coverLetters } = schema;

export interface DocumentLinkIds {
  resumeOptimizationId?: string | null;
  applicationPitchId?: string | null;
  coverLetterId?: string | null;
}

export interface LinkedDocuments {
  resume: SnapshotDocumentRef | null;
  pitch: SnapshotDocumentRef | null;
  coverLetter: SnapshotDocumentRef | null;
  /** The linked resume's ATS evaluation, if both exist. */
  ats: SnapshotAtsInput | null;
}

/**
 * Call inside withUserContext. Loads each non-null linked document, requiring it to belong to `jobId`
 * (design §3: enforced here because a CHECK cannot reference other tables). Any miss -- wrong job,
 * another user's row (hidden by RLS), or a deleted row -- is `document_mismatch`.
 */
export async function loadLinkedDocuments(tx: DbClient, jobId: string, ids: DocumentLinkIds): Promise<LinkedDocuments> {
  const result: LinkedDocuments = { resume: null, pitch: null, coverLetter: null, ats: null };

  if (ids.resumeOptimizationId) {
    const [row] = await tx
      .select({
        id: resumeOptimizations.id,
        version: resumeOptimizations.version,
        hash: resumeOptimizations.sourceProfileContentHash,
        atsOverall: atsEvaluations.overallScore,
        atsRequired: atsEvaluations.requiredKeywordCoverage,
        atsPreferred: atsEvaluations.preferredKeywordCoverage,
        atsSemantic: atsEvaluations.semanticSimilarity,
      })
      .from(resumeOptimizations)
      .leftJoin(atsEvaluations, eq(atsEvaluations.resumeOptimizationId, resumeOptimizations.id))
      .where(and(eq(resumeOptimizations.id, ids.resumeOptimizationId), eq(resumeOptimizations.jobId, jobId)))
      .limit(1);
    if (!row) throw new ApplicationError("document_mismatch");
    result.resume = { id: row.id, version: row.version, origin: null, sourceProfileContentHash: row.hash };
    if (row.atsOverall !== null && row.atsRequired !== null && row.atsPreferred !== null) {
      result.ats = {
        overallScore: row.atsOverall, requiredKeywordCoverage: row.atsRequired,
        preferredKeywordCoverage: row.atsPreferred, semanticSimilarity: row.atsSemantic,
      };
    }
  }

  if (ids.applicationPitchId) {
    const [row] = await tx
      .select({ id: applicationPitches.id, version: applicationPitches.version, origin: applicationPitches.origin, hash: applicationPitches.sourceProfileContentHash })
      .from(applicationPitches)
      .where(and(eq(applicationPitches.id, ids.applicationPitchId), eq(applicationPitches.jobId, jobId)))
      .limit(1);
    if (!row) throw new ApplicationError("document_mismatch");
    result.pitch = { id: row.id, version: row.version, origin: row.origin, sourceProfileContentHash: row.hash };
  }

  if (ids.coverLetterId) {
    const [row] = await tx
      .select({ id: coverLetters.id, version: coverLetters.version, origin: coverLetters.origin, hash: coverLetters.sourceProfileContentHash })
      .from(coverLetters)
      .where(and(eq(coverLetters.id, ids.coverLetterId), eq(coverLetters.jobId, jobId)))
      .limit(1);
    if (!row) throw new ApplicationError("document_mismatch");
    result.coverLetter = { id: row.id, version: row.version, origin: row.origin, sourceProfileContentHash: row.hash };
  }

  return result;
}
```

`packages/applications/src/createApplication.ts`:
```ts
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import { todayUtc, type CreateApplicationBody } from "./bodies";
import { buildFeatureSnapshot } from "./snapshot";
import { loadLinkedDocuments } from "./documentLinks";
import type { ApplicationRow } from "./types";

const { jobs, jobPostings, jobMatches, applications, applicationEvents } = schema;

/** Postgres unique_violation (23505), bare or wrapped as `cause` by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Phase 9 design §4.4. Builds the feature snapshot server-side (the client never sends one) and writes
 * the application plus its initial status_change event in one transaction. The partial unique index
 * (user_id, job_id) is the concurrency backstop for "one application per job" -> already_applied.
 */
export async function createApplication(
  db: DbClient,
  userId: string,
  body: CreateApplicationBody,
  now: Date = new Date()
): Promise<ApplicationRow> {
  const appliedAt = body.appliedAt ?? todayUtc(now);
  try {
    return await withUserContext(db, userId, async (tx) => {
      let values: Pick<ApplicationRow, "jobId" | "companyName" | "jobTitle" | "jobUrl" | "featureSnapshot" | "resumeOptimizationId" | "applicationPitchId" | "coverLetterId">;

      if (body.external) {
        values = {
          jobId: null,
          companyName: body.external.companyName,
          jobTitle: body.external.jobTitle,
          jobUrl: body.external.jobUrl ?? null,
          featureSnapshot: buildFeatureSnapshot({ kind: "external", companyName: body.external.companyName, jobTitle: body.external.jobTitle }),
          resumeOptimizationId: null,
          applicationPitchId: null,
          coverLetterId: null,
        };
      } else {
        const jobId = body.jobId!;
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
        if (!job) throw new ApplicationError("job_not_found");
        const docs = await loadLinkedDocuments(tx, jobId, body);
        const [match] = await tx.select().from(jobMatches).where(eq(jobMatches.jobId, jobId)).limit(1);
        const [posting] = await tx
          .select({ url: jobPostings.url })
          .from(jobPostings)
          .where(and(eq(jobPostings.jobId, jobId), isNotNull(jobPostings.url)))
          .orderBy(desc(jobPostings.lastSeenAt))
          .limit(1);
        values = {
          jobId,
          companyName: job.companyName,
          jobTitle: job.title,
          jobUrl: posting?.url ?? null,
          featureSnapshot: buildFeatureSnapshot({
            kind: "ingested",
            job,
            match: match ?? null,
            ats: docs.ats,
            documents: { resume: docs.resume, pitch: docs.pitch, coverLetter: docs.coverLetter },
            appliedAt,
          }),
          resumeOptimizationId: docs.resume?.id ?? null,
          applicationPitchId: docs.pitch?.id ?? null,
          coverLetterId: docs.coverLetter?.id ?? null,
        };
      }

      const [row] = await tx
        .insert(applications)
        .values({
          ...values,
          status: "applied",
          statusChangedAt: now,
          appliedAt,
          followUpAt: body.followUpAt ?? null,
          notes: body.notes || null,
          updatedAt: now,
        })
        .returning();
      await tx.insert(applicationEvents).values({
        applicationId: row.id, type: "status_change", occurredAt: now, fromStatus: null, toStatus: "applied", detail: {},
      });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApplicationError("already_applied");
    throw error;
  }
}
```

Run: `pnpm --filter @ai-career/applications test -- createApplication`
Expected: PASS (6 tests). If the `job` object passed to `buildFeatureSnapshot` fails typecheck (e.g. `workMode` enum vs string), it is structurally compatible. Only adjust `SnapshotJobInput` field types if tsc names a real mismatch.

- [ ] **Step 4: Write the failing read test**

`packages/applications/src/readApplications.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "./testing";
import { createApplication } from "./createApplication";
import { getApplication, listApplications, getApplicationForJob, listDocumentOptions } from "./readApplications";

const USER = "00000000-0000-0000-0000-0000000009a3";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

const external = (companyName: string, extra: Record<string, unknown> = {}) =>
  createApplication(t.db, USER, { external: { companyName, jobTitle: "Analyst" }, ...extra });

describe("read applications", () => {
  it("getApplication returns the row with events oldest-first, or null", async () => {
    const row = await external("Globex");
    await t.adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, detail)
                     VALUES (${USER}, ${row.id}, 'note', now() + interval '1 minute', '{"text":"later"}'::jsonb)`;
    const got = await getApplication(t.db, USER, row.id);
    expect(got?.application.id).toBe(row.id);
    expect(got?.events.map((e) => e.type)).toEqual(["status_change", "note"]);
    expect(await getApplication(t.db, USER, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("listApplications orders by applied date, filters by status and counts due follow-ups on open applications only", async () => {
    const a = await external("A", { appliedAt: "2026-09-01", followUpAt: "2026-09-10" });
    await external("B", { appliedAt: "2026-09-20", followUpAt: "2026-12-01" });
    const c = await external("C", { appliedAt: "2026-09-10", followUpAt: "2026-09-05" });
    await t.adminSql`UPDATE applications SET status = 'rejected', terminal_at = now() WHERE id = ${c.id}`;

    const all = await listApplications(t.db, USER, { today: "2026-09-30" });
    expect(all.applications.map((r) => r.companyName)).toEqual(["B", "C", "A"]);
    expect(all.dueCount).toBe(1);

    const due = await listApplications(t.db, USER, { today: "2026-09-30", dueOnly: true });
    expect(due.applications.map((r) => r.id)).toEqual([a.id]);

    const rejected = await listApplications(t.db, USER, { today: "2026-09-30", status: "rejected" });
    expect(rejected.applications.map((r) => r.id)).toEqual([c.id]);
  });

  it("getApplicationForJob and listDocumentOptions serve the match page", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    expect(await getApplicationForJob(t.db, USER, s.jobId)).toBeNull();
    await t.adminSql`INSERT INTO application_pitches (user_id, job_id, version, origin, research_status_snapshot, bullets, requires_review)
                     SELECT user_id, job_id, 2, 'user_edited', research_status_snapshot, bullets, false FROM application_pitches WHERE id = ${s.pitchId}`;

    const options = await listDocumentOptions(t.db, USER, s.jobId);
    expect(options.resumes).toEqual([{ id: s.resumeId, version: 1, origin: null }]);
    expect(options.pitches.map((p) => [p.version, p.origin])).toEqual([[2, "user_edited"], [1, "generated"]]);
    expect(options.coverLetters).toEqual([{ id: s.coverLetterId, version: 1, origin: "generated" }]);

    const row = await createApplication(t.db, USER, { jobId: s.jobId });
    expect((await getApplicationForJob(t.db, USER, s.jobId))?.id).toBe(row.id);
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- readApplications`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `readApplications.ts`**

```ts
import { and, asc, count, desc, eq, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { ApplicationEventRow, ApplicationRow, ApplicationStatus } from "./types";

const { applications, applicationEvents, resumeOptimizations, applicationPitches, coverLetters } = schema;

export interface DocumentOption {
  id: string;
  version: number;
  origin: "generated" | "user_edited" | null;
}
export interface DocumentOptions {
  resumes: DocumentOption[];
  pitches: DocumentOption[];
  coverLetters: DocumentOption[];
}

/** A follow-up is due when its date is today or earlier and the application is still open. */
const dueCondition = (today: string): SQL =>
  and(isNotNull(applications.followUpAt), lte(applications.followUpAt, today), isNull(applications.terminalAt))!;

export async function getApplication(
  db: DbClient,
  userId: string,
  id: string
): Promise<{ application: ApplicationRow; events: ApplicationEventRow[] } | null> {
  return withUserContext(db, userId, async (tx) => {
    const [application] = await tx.select().from(applications).where(eq(applications.id, id)).limit(1);
    if (!application) return null;
    const events = await tx
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.applicationId, id))
      .orderBy(asc(applicationEvents.occurredAt), asc(applicationEvents.createdAt));
    return { application, events };
  });
}

export async function listApplications(
  db: DbClient,
  userId: string,
  opts: { status?: ApplicationStatus; dueOnly?: boolean; today: string }
): Promise<{ applications: ApplicationRow[]; dueCount: number }> {
  return withUserContext(db, userId, async (tx) => {
    const filters: SQL[] = [];
    if (opts.status) filters.push(eq(applications.status, opts.status));
    if (opts.dueOnly) filters.push(dueCondition(opts.today));
    const rows = await tx
      .select()
      .from(applications)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(applications.appliedAt), desc(applications.createdAt));
    const [{ n }] = await tx.select({ n: count() }).from(applications).where(dueCondition(opts.today));
    return { applications: rows, dueCount: n };
  });
}

export async function getApplicationForJob(db: DbClient, userId: string, jobId: string): Promise<ApplicationRow | null> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx.select().from(applications).where(eq(applications.jobId, jobId)).limit(1);
    return row ?? null;
  });
}

/** The versions the "Mark as applied" panel offers, newest first. */
export async function listDocumentOptions(db: DbClient, userId: string, jobId: string): Promise<DocumentOptions> {
  return withUserContext(db, userId, async (tx) => {
    const resumes = await tx
      .select({ id: resumeOptimizations.id, version: resumeOptimizations.version })
      .from(resumeOptimizations)
      .where(eq(resumeOptimizations.jobId, jobId))
      .orderBy(desc(resumeOptimizations.version));
    const pitches = await tx
      .select({ id: applicationPitches.id, version: applicationPitches.version, origin: applicationPitches.origin })
      .from(applicationPitches)
      .where(eq(applicationPitches.jobId, jobId))
      .orderBy(desc(applicationPitches.version));
    const letters = await tx
      .select({ id: coverLetters.id, version: coverLetters.version, origin: coverLetters.origin })
      .from(coverLetters)
      .where(eq(coverLetters.jobId, jobId))
      .orderBy(desc(coverLetters.version));
    return { resumes: resumes.map((r) => ({ ...r, origin: null })), pitches, coverLetters: letters };
  });
}
```

Run: `pnpm --filter @ai-career/applications test -- readApplications`
Expected: PASS (3 tests).

- [ ] **Step 6: Export, run the package, commit**

Append to `packages/applications/src/index.ts`:
```ts
export { loadLinkedDocuments, type DocumentLinkIds, type LinkedDocuments } from "./documentLinks";
export { createApplication } from "./createApplication";
export {
  getApplication, listApplications, getApplicationForJob, listDocumentOptions, type DocumentOption, type DocumentOptions,
} from "./readApplications";
```

Run: `pnpm --filter @ai-career/applications test && pnpm --filter @ai-career/applications typecheck && pnpm --filter @ai-career/applications lint`
Expected: all green.

```bash
git add packages/applications
git commit -m "feat(applications): create and read applications with same-job document validation"
```

---

### Task 5: Status changes, events, edits and delete (DB)

**Files:**
- Create: `packages/applications/src/mutateApplication.ts`
- Modify: `packages/applications/src/index.ts`
- Test: `packages/applications/src/mutateApplication.test.ts`

**Interfaces:**
- Consumes: `planStatusChange` (Task 2), `loadLinkedDocuments` (Task 4), body types (Task 2).
- Produces:
  - `changeStatus(db, userId, id, body: ChangeStatusBody, now?: Date): Promise<ApplicationRow>`
  - `addEvent(db, userId, id, body: UserEventBody, now?: Date): Promise<ApplicationEventRow>`
  - `updateApplication(db, userId, id, body: UpdateApplicationBody, now?: Date): Promise<ApplicationRow>`
  - `deleteApplication(db, userId, id): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

`packages/applications/src/mutateApplication.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "./testing";
import { createApplication } from "./createApplication";
import { changeStatus, addEvent, updateApplication, deleteApplication } from "./mutateApplication";
import { ApplicationError } from "./errors";

const USER = "00000000-0000-0000-0000-0000000009a4";
const T0 = new Date("2026-09-30T10:00:00Z");
const T1 = new Date("2026-10-05T10:00:00Z");
const T2 = new Date("2026-10-06T10:00:00Z");
const MISSING = "11111111-1111-4111-8111-111111111111";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

const errorClassOf = (p: Promise<unknown>) =>
  p.then(() => "resolved", (e) => (e instanceof ApplicationError ? e.errorClass : `other:${String(e)}`));
const external = () => createApplication(t.db, USER, { external: { companyName: "Globex", jobTitle: "Analyst" } }, T0);
// Events written in one transaction share created_at (now() is the transaction start), so order is not asserted within one.
const eventsOf = (id: string) =>
  t.adminSql`SELECT type, from_status, to_status, detail, occurred_at FROM application_events WHERE application_id = ${id}`;

describe("changeStatus", () => {
  it("updates the row, logs the change, and starts the terminal clock at now even when backdated", async () => {
    const app = await external();
    const row = await changeStatus(t.db, USER, app.id, { toStatus: "rejected", occurredAt: "2026-09-01T09:00:00Z", note: "Form email" }, T1);
    expect(row.status).toBe("rejected");
    expect(row.statusChangedAt).toEqual(new Date("2026-09-01T09:00:00Z"));
    expect(row.terminalAt).toEqual(T1);
    const events = await eventsOf(app.id);
    expect(events).toHaveLength(3);
    expect(events.map((e) => [e.type, e.from_status, e.to_status])).toEqual(expect.arrayContaining([
      ["status_change", null, "applied"], ["status_change", "applied", "rejected"], ["note", null, null],
    ]));
    expect(events.find((e) => e.type === "note")?.detail).toEqual({ text: "Form email" });
  });

  it("clears the clock on reopen and keeps it on terminal-to-terminal", async () => {
    const app = await external();
    await changeStatus(t.db, USER, app.id, { toStatus: "rejected" }, T1);
    expect((await changeStatus(t.db, USER, app.id, { toStatus: "withdrawn" }, T2)).terminalAt).toEqual(T1);
    expect((await changeStatus(t.db, USER, app.id, { toStatus: "interviewing" }, T2)).terminalAt).toBeNull();
  });

  it("rejects the same status and an unknown application", async () => {
    const app = await external();
    expect(await errorClassOf(changeStatus(t.db, USER, app.id, { toStatus: "applied" }, T1))).toBe("same_status");
    expect(await errorClassOf(changeStatus(t.db, USER, MISSING, { toStatus: "offer" }, T1))).toBe("not_found");
  });
});

describe("addEvent", () => {
  it("logs a note with the given occurredAt", async () => {
    const app = await external();
    const ev = await addEvent(t.db, USER, app.id, { type: "note", occurredAt: "2026-10-01T08:00:00Z", detail: { text: "Called" } }, T1);
    expect(ev).toMatchObject({ type: "note", occurredAt: new Date("2026-10-01T08:00:00Z"), detail: { text: "Called" } });
  });

  it("follow_up_done clears the follow-up date and follow_up_snoozed moves it", async () => {
    const app = await createApplication(t.db, USER, { external: { companyName: "G", jobTitle: "A" }, followUpAt: "2026-10-01" }, T0);
    await addEvent(t.db, USER, app.id, { type: "follow_up_snoozed", detail: { newFollowUpAt: "2026-10-08" } }, T1);
    let [row] = await t.adminSql`SELECT follow_up_at::text AS f FROM applications WHERE id = ${app.id}`;
    expect(row.f).toBe("2026-10-08");
    await addEvent(t.db, USER, app.id, { type: "follow_up_done", detail: {} }, T2);
    [row] = await t.adminSql`SELECT follow_up_at FROM applications WHERE id = ${app.id}`;
    expect(row.follow_up_at).toBeNull();
  });

  it("returns not_found for an unknown application", async () => {
    expect(await errorClassOf(addEvent(t.db, USER, MISSING, { type: "note", detail: { text: "x" } }, T1))).toBe("not_found");
  });
});

describe("updateApplication", () => {
  it("edits only the given fields and never the snapshot", async () => {
    const app = await external();
    const row = await updateApplication(t.db, USER, app.id, { recruiterName: "Sam", followUpAt: "2026-10-09" }, T1);
    expect(row).toMatchObject({ recruiterName: "Sam", followUpAt: "2026-10-09", companyName: "Globex", featureSnapshot: app.featureSnapshot });
  });

  it("validates document links against the application's job", async () => {
    const a = await seedJobWithDocuments(t.adminSql, USER, { title: "Data Engineer" });
    const b = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    const app = await createApplication(t.db, USER, { jobId: a.jobId }, T0);
    expect((await updateApplication(t.db, USER, app.id, { coverLetterId: a.coverLetterId }, T1)).coverLetterId).toBe(a.coverLetterId);
    expect(await errorClassOf(updateApplication(t.db, USER, app.id, { coverLetterId: b.coverLetterId }, T1))).toBe("document_mismatch");
    const ext = await external();
    expect(await errorClassOf(updateApplication(t.db, USER, ext.id, { coverLetterId: a.coverLetterId }, T1))).toBe("document_mismatch");
  });

  it("returns not_found for an unknown application", async () => {
    expect(await errorClassOf(updateApplication(t.db, USER, MISSING, { notes: "x" }, T1))).toBe("not_found");
  });
});

describe("deleteApplication", () => {
  it("deletes the application and its events, and reports whether it existed", async () => {
    const app = await external();
    expect(await deleteApplication(t.db, USER, app.id)).toBe(true);
    expect(await eventsOf(app.id)).toHaveLength(0);
    expect(await deleteApplication(t.db, USER, app.id)).toBe(false);
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- mutateApplication`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement `mutateApplication.ts`**

```ts
import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import { planStatusChange } from "./status";
import { loadLinkedDocuments } from "./documentLinks";
import type { ChangeStatusBody, UpdateApplicationBody, UserEventBody } from "./bodies";
import type { ApplicationEventRow, ApplicationRow } from "./types";

const { applications, applicationEvents } = schema;

/** Locks the row for the rest of the transaction so concurrent changes serialize. */
async function lockApplication(tx: DbClient, id: string): Promise<ApplicationRow> {
  const [row] = await tx.select().from(applications).where(eq(applications.id, id)).for("update");
  if (!row) throw new ApplicationError("not_found");
  return row;
}

export async function changeStatus(
  db: DbClient,
  userId: string,
  id: string,
  body: ChangeStatusBody,
  now: Date = new Date()
): Promise<ApplicationRow> {
  return withUserContext(db, userId, async (tx) => {
    const current = await lockApplication(tx, id);
    const plan = planStatusChange({
      current: current.status,
      currentTerminalAt: current.terminalAt,
      to: body.toStatus,
      now,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
    });
    const [row] = await tx
      .update(applications)
      .set({ status: plan.status, statusChangedAt: plan.statusChangedAt, terminalAt: plan.terminalAt, updatedAt: now })
      .where(eq(applications.id, id))
      .returning();
    await tx.insert(applicationEvents).values({
      applicationId: id, type: "status_change", occurredAt: plan.statusChangedAt, fromStatus: current.status, toStatus: plan.status, detail: {},
    });
    if (body.note) {
      await tx.insert(applicationEvents).values({ applicationId: id, type: "note", occurredAt: plan.statusChangedAt, detail: { text: body.note } });
    }
    return row;
  });
}

export async function addEvent(
  db: DbClient,
  userId: string,
  id: string,
  body: UserEventBody,
  now: Date = new Date()
): Promise<ApplicationEventRow> {
  return withUserContext(db, userId, async (tx) => {
    await lockApplication(tx, id);
    if (body.type === "follow_up_done") {
      await tx.update(applications).set({ followUpAt: null, updatedAt: now }).where(eq(applications.id, id));
    } else if (body.type === "follow_up_snoozed") {
      await tx.update(applications).set({ followUpAt: body.detail.newFollowUpAt, updatedAt: now }).where(eq(applications.id, id));
    }
    const [event] = await tx
      .insert(applicationEvents)
      .values({ applicationId: id, type: body.type, occurredAt: body.occurredAt ? new Date(body.occurredAt) : now, detail: body.detail })
      .returning();
    return event;
  });
}

/** Edits user-owned fields only. feature_snapshot is never touched (design §3), even when links change. */
export async function updateApplication(
  db: DbClient,
  userId: string,
  id: string,
  body: UpdateApplicationBody,
  now: Date = new Date()
): Promise<ApplicationRow> {
  return withUserContext(db, userId, async (tx) => {
    const current = await lockApplication(tx, id);
    const linksChanged = [body.resumeOptimizationId, body.applicationPitchId, body.coverLetterId].some((v) => v !== undefined && v !== null);
    if (linksChanged) {
      if (current.jobId === null) throw new ApplicationError("document_mismatch");
      await loadLinkedDocuments(tx, current.jobId, body);
    }
    const patch = Object.fromEntries(
      Object.entries(body).map(([k, v]) => [k, typeof v === "string" && v === "" ? null : v]).filter(([, v]) => v !== undefined)
    ) as Partial<ApplicationRow>;
    const [row] = await tx.update(applications).set({ ...patch, updatedAt: now }).where(eq(applications.id, id)).returning();
    return row;
  });
}

export async function deleteApplication(db: DbClient, userId: string, id: string): Promise<boolean> {
  return withUserContext(db, userId, async (tx) => {
    const rows = await tx.delete(applications).where(eq(applications.id, id)).returning({ id: applications.id });
    return rows.length > 0;
  });
}
```

Run: `pnpm --filter @ai-career/applications test -- mutateApplication`
Expected: PASS (10 tests).

- [ ] **Step 3: Export, run the package, commit**

Append to `packages/applications/src/index.ts`:
```ts
export { changeStatus, addEvent, updateApplication, deleteApplication } from "./mutateApplication";
```

Run: `pnpm --filter @ai-career/applications test && pnpm --filter @ai-career/applications typecheck && pnpm --filter @ai-career/applications lint`
```bash
git add packages/applications
git commit -m "feat(applications): status changes, user events, edits and delete"
```

---

### Task 6: "Already applied" eligibility rule in matching

**Files:**
- Modify: `packages/matching/src/eligibility/evaluateEligibility.ts`, `packages/matching/src/eligibility/evaluateEligibility.test.ts`
- Modify: `packages/matching/src/pipeline/runMatching.ts`, `packages/matching/src/pipeline/runMatching.test.ts`
- Modify: `packages/matching/src/testing/db.ts`

**Interfaces:**
- Consumes: `schema.applications` (Task 1).
- Produces: `EligibilityInput.alreadyApplied: boolean` (required). Reason text: `` `You applied to this job at ${companyName}.` ``

- [ ] **Step 1: Find every caller**

Run: `grep -rn "evaluateEligibility(\|previouslyDismissed" packages apps services --include=*.ts | grep -v node_modules`
Expected: `evaluateEligibility.ts`, its test, and `runMatching.ts`. Every object literal passed to `evaluateEligibility` must gain `alreadyApplied`.

- [ ] **Step 2: Write the failing unit test**

In `evaluateEligibility.test.ts`, add `alreadyApplied: false` to the shared `base` input object, then add inside the main `describe`:
```ts
  it("excludes a job the user already applied to, before any other rule", () => {
    const result = evaluateEligibility({ ...base, alreadyApplied: true, previouslyDismissed: true });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(`You applied to this job at ${base.companyName}.`);
  });
```

Run: `pnpm --filter @ai-career/matching test -- evaluateEligibility`
Expected: FAIL (reason is the dismissed text).

- [ ] **Step 3: Implement**

In `evaluateEligibility.ts` add to `EligibilityInput` after `previouslyDismissed`:
```ts
  /** An application exists for this job (Phase 9). Checked first: the user already acted on it. */
  alreadyApplied: boolean;
```
and at the top of `evaluateEligibility`, before the dismissed check:
```ts
  if (input.alreadyApplied) {
    return { eligible: false, reason: `You applied to this job at ${input.companyName}.` };
  }
```
Update the doc comment's ordering sentence to: `"already applied" is checked first, then "previously dismissed", since both reflect an explicit user decision that no other rule should second-guess.`

Run: `pnpm --filter @ai-career/matching test -- evaluateEligibility`
Expected: PASS.

- [ ] **Step 4: Write the failing pipeline test**

In `packages/matching/src/testing/db.ts`, make `wipeUser` start with:
```ts
  await adminSql`DELETE FROM applications WHERE user_id = ${userId}`;
```

In `runMatching.test.ts`, add inside the main `describe` (it reuses `seedGoalAndProfile`, `seedJob`, `fakeAnthropic`, `ENV`, `USER`, `testDb` already defined in that file):
```ts
  it("marks a job with an application as ineligible, and restores it once the application is deleted", async () => {
    await seedGoalAndProfile();
    const jobId = await seedJob({ title: "Data Engineer" });
    await testDb.adminSql`
      INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot)
      VALUES (${USER}, ${jobId}, 'Acme', 'Data Engineer', 'applied', now(), current_date, '{}'::jsonb)`;

    await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV });
    let [row] = await testDb.adminSql`SELECT eligible, ineligible_reason FROM job_matches WHERE job_id = ${jobId}`;
    expect(row.eligible).toBe(false);
    expect(row.ineligible_reason).toBe("You applied to this job at Acme.");

    await testDb.adminSql`DELETE FROM applications WHERE user_id = ${USER}`;
    await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV });
    [row] = await testDb.adminSql`SELECT eligible FROM job_matches WHERE job_id = ${jobId}`;
    expect(row.eligible).toBe(true);
  });
```

Run: `pnpm --filter @ai-career/matching test -- runMatching`
Expected: FAIL (typecheck error on the missing `alreadyApplied`, or the job is eligible).

- [ ] **Step 5: Implement in `runMatching.ts`**

Change the destructuring line to include `applications`:
```ts
const { careerGoals, careerGoalConstraints, candidateProfiles, jobMatches, matchingRuns, applications } = schema;
```
Add `isNotNull` to the drizzle import: `import { and, eq, isNotNull } from "drizzle-orm";`

After `const existingByJobId = ...`, add:
```ts
    // Phase 9: one query per run; a job with an application is excluded as "already applied".
    const appliedRows = await inUserContext((tx) =>
      tx.select({ jobId: applications.jobId }).from(applications).where(isNotNull(applications.jobId))
    );
    const appliedJobIds = new Set(appliedRows.map((r) => r.jobId as string));
```
and in the `evaluateEligibility({...})` call add:
```ts
        alreadyApplied: appliedJobIds.has(job.id),
```

Run: `pnpm --filter @ai-career/matching test && pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/matching
git commit -m "feat(matching): exclude jobs with an application as already applied"
```

---

### Task 7: Retention planners (pure)

**Files:**
- Create: `packages/applications/src/retention/planRetention.ts`
- Modify: `packages/applications/src/index.ts`
- Test: `packages/applications/src/retention/planRetention.test.ts`

**Interfaces:**
- Produces:
  - `interface RetentionCandidate { id: string; jobId: string | null; terminalAt: Date | null; retentionPurgedAt: Date | null }`
  - `isDueForPurge(c: RetentionCandidate, now: Date, retentionDays: number): boolean`
  - `planRetention(input: { candidates: RetentionCandidate[]; now: Date; retentionDays: number }): RetentionCandidate[]`
  - `interface StoredObject { key: string; lastModified: Date }`, `ORPHAN_MIN_AGE_MS = 86_400_000`
  - `planOrphanSweep(input: { objects: StoredObject[]; referencedKeys: ReadonlySet<string>; now: Date; minAgeMs?: number }): string[]`

- [ ] **Step 1: Write the failing test**

`packages/applications/src/retention/planRetention.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isDueForPurge, planRetention, planOrphanSweep, ORPHAN_MIN_AGE_MS, type RetentionCandidate } from "./planRetention";

const DAY = 86_400_000;
const NOW = new Date("2026-11-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const c = (over: Partial<RetentionCandidate>): RetentionCandidate => ({ id: "a", jobId: "j", terminalAt: daysAgo(31), retentionPurgedAt: null, ...over });

describe("isDueForPurge", () => {
  it("is due exactly at the retention boundary, not a millisecond before", () => {
    expect(isDueForPurge(c({ terminalAt: daysAgo(30) }), NOW, 30)).toBe(true);
    expect(isDueForPurge(c({ terminalAt: new Date(daysAgo(30).getTime() + 1) }), NOW, 30)).toBe(false);
  });
  it("is never due when disabled, open, or external", () => {
    expect(isDueForPurge(c({}), NOW, 0)).toBe(false);
    expect(isDueForPurge(c({ terminalAt: null }), NOW, 30)).toBe(false);
    expect(isDueForPurge(c({ jobId: null }), NOW, 30)).toBe(false);
  });
  it("is not due again after a purge, unless the application was reopened and closed again later", () => {
    expect(isDueForPurge(c({ terminalAt: daysAgo(40), retentionPurgedAt: daysAgo(10) }), NOW, 30)).toBe(false);
    expect(isDueForPurge(c({ terminalAt: daysAgo(35), retentionPurgedAt: daysAgo(60) }), NOW, 30)).toBe(true);
  });
});

describe("planRetention", () => {
  it("keeps only due candidates", () => {
    const due = c({ id: "due" });
    expect(planRetention({ candidates: [due, c({ id: "fresh", terminalAt: daysAgo(1) })], now: NOW, retentionDays: 30 })).toEqual([due]);
  });
});

describe("planOrphanSweep", () => {
  it("returns unreferenced objects at least 24h old", () => {
    const objects = [
      { key: "u/referenced.pdf", lastModified: daysAgo(5) },
      { key: "u/orphan-old.pdf", lastModified: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS) },
      { key: "u/orphan-new.pdf", lastModified: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS + 1) },
    ];
    expect(planOrphanSweep({ objects, referencedKeys: new Set(["u/referenced.pdf"]), now: NOW })).toEqual(["u/orphan-old.pdf"]);
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- planRetention`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement `planRetention.ts`**

```ts
const MS_PER_DAY = 86_400_000;

/** An upload whose DB row may not be committed yet must not be swept (design §4.5). */
export const ORPHAN_MIN_AGE_MS = MS_PER_DAY;

export interface RetentionCandidate {
  id: string;
  jobId: string | null;
  terminalAt: Date | null;
  retentionPurgedAt: Date | null;
}

export interface StoredObject {
  key: string;
  lastModified: Date;
}

/**
 * Due when: enabled, the application has a job (external ones have no generated data), it has been
 * terminal for at least `retentionDays`, and it has not been purged since that terminal_at. A
 * reopen-then-close sets a later terminal_at, so it becomes due again.
 */
export function isDueForPurge(candidate: RetentionCandidate, now: Date, retentionDays: number): boolean {
  if (retentionDays <= 0 || candidate.jobId === null || candidate.terminalAt === null) return false;
  if (candidate.terminalAt.getTime() > now.getTime() - retentionDays * MS_PER_DAY) return false;
  return candidate.retentionPurgedAt === null || candidate.retentionPurgedAt.getTime() < candidate.terminalAt.getTime();
}

export function planRetention(input: { candidates: RetentionCandidate[]; now: Date; retentionDays: number }): RetentionCandidate[] {
  return input.candidates.filter((c) => isDueForPurge(c, input.now, input.retentionDays));
}

export function planOrphanSweep(input: {
  objects: StoredObject[];
  referencedKeys: ReadonlySet<string>;
  now: Date;
  minAgeMs?: number;
}): string[] {
  const minAgeMs = input.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  return input.objects
    .filter((o) => !input.referencedKeys.has(o.key) && input.now.getTime() - o.lastModified.getTime() >= minAgeMs)
    .map((o) => o.key);
}
```

Run: `pnpm --filter @ai-career/applications test -- planRetention`
Expected: PASS.

- [ ] **Step 3: Export and commit**

Append to `packages/applications/src/index.ts`:
```ts
export {
  isDueForPurge, planRetention, planOrphanSweep, ORPHAN_MIN_AGE_MS, type RetentionCandidate, type StoredObject,
} from "./retention/planRetention";
```

```bash
git add packages/applications
git commit -m "feat(applications): pure retention and orphan-sweep planners"
```

---

### Task 8: Retention sweep (DB + storage), `RETENTION_DAYS`, object listing

**Files:**
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`
- Modify: `packages/storage/src/generatedDocumentStorage.ts`, `packages/storage/src/generatedDocumentStorage.test.ts`, `packages/storage/src/index.ts`
- Create: `packages/applications/src/retention/runRetentionSweep.ts`
- Modify: `packages/applications/src/index.ts`
- Test: `packages/applications/src/retention/runRetentionSweep.test.ts`

**Interfaces:**
- Consumes: `isDueForPurge`, `planRetention`, `planOrphanSweep`, `StoredObject` (Task 7); `seedJobWithDocuments` (Task 4).
- Produces:
  - `Env.RETENTION_DAYS: number`
  - `listGeneratedDocuments(client: Client, prefix: string): Promise<{ key: string; lastModified: Date }[]>` from `@ai-career/storage`
  - `interface RetentionStorage { listObjects(prefix: string): Promise<StoredObject[]>; removeObject(key: string): Promise<void> }`
  - `interface RetentionSweepResult { status: "disabled" | "completed"; purgedApplications: number; deletedRows: number; deletedObjects: number; orphanObjectsDeleted: number; failedObjectDeletes: number }`
  - `runRetentionSweep(opts: { db: DbClient; storage: RetentionStorage; userId: string; retentionDays: number; now?: Date }): Promise<RetentionSweepResult>`

- [ ] **Step 1: `RETENTION_DAYS` (test first)**

Add inside the `describe("loadEnv")` block of `packages/config/src/env.test.ts` (it uses the file's existing `validSource` fixture):
```ts
  it("defaults RETENTION_DAYS to 30, accepts 0, and rejects negatives", () => {
    expect(loadEnv({ ...validSource }).RETENTION_DAYS).toBe(30);
    expect(loadEnv({ ...validSource, RETENTION_DAYS: "0" }).RETENTION_DAYS).toBe(0);
    expect(() => loadEnv({ ...validSource, RETENTION_DAYS: "-1" })).toThrow(/RETENTION_DAYS/);
  });
```
Run: `pnpm --filter @ai-career/config test` → FAIL.

Add to the schema in `env.ts`, after `COMPANY_RESEARCH_MAX_SEARCHES`:
```ts
    // Phase 9: days after an application reaches a terminal status before its job's generated documents
    // are deleted (architecture §9). 0 disables the retention sweep entirely.
    RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
```
Run: `pnpm --filter @ai-career/config test` → PASS.

- [ ] **Step 2: `listGeneratedDocuments` (test first)**

Add to `packages/storage/src/generatedDocumentStorage.test.ts` (import `listGeneratedDocuments` alongside the others):
```ts
  it("lists objects under a prefix with their last-modified time", async () => {
    const userId = "00000000-0000-0000-0000-0000000009a9";
    const { objectKey } = await uploadGeneratedDocument(client, { userId, buffer: Buffer.from("x"), extension: "pdf" });
    created.push(objectKey);
    const listed = await listGeneratedDocuments(client, `${userId}/`);
    const mine = listed.find((o) => o.key === objectKey);
    expect(mine?.lastModified).toBeInstanceOf(Date);
    expect(listed.every((o) => o.key.startsWith(`${userId}/`))).toBe(true);
  });
```
Run: `pnpm --filter @ai-career/storage test` → FAIL.

Add to `generatedDocumentStorage.ts`:
```ts
/** Every object under `prefix` (recursive). An absent bucket has no objects. */
export async function listGeneratedDocuments(client: Client, prefix: string): Promise<{ key: string; lastModified: Date }[]> {
  const exists = await client.bucketExists(GENERATED_DOCUMENTS_BUCKET);
  if (!exists) return [];
  return new Promise((resolve, reject) => {
    const objects: { key: string; lastModified: Date }[] = [];
    const stream = client.listObjectsV2(GENERATED_DOCUMENTS_BUCKET, prefix, true);
    stream.on("data", (item) => {
      if (item.name && item.lastModified) objects.push({ key: item.name, lastModified: item.lastModified });
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(objects));
  });
}
```
Add `listGeneratedDocuments` to the export list in `packages/storage/src/index.ts`.
Run: `pnpm --filter @ai-career/storage test && pnpm --filter @ai-career/storage typecheck` → PASS.

- [ ] **Step 3: Write the failing sweep test**

`packages/applications/src/retention/runRetentionSweep.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "../testing";
import { createApplication } from "../createApplication";
import { runRetentionSweep, type RetentionStorage } from "./runRetentionSweep";
import type { StoredObject } from "./planRetention";

const USER = "00000000-0000-0000-0000-0000000009a5";
const NOW = new Date("2026-11-15T00:00:00Z");
const DAY = 86_400_000;
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

/** In-memory storage: records removals; keys listed in `failKeys` throw on remove. */
function fakeStorage(objects: StoredObject[] = [], failKeys: string[] = []) {
  const removed: string[] = [];
  const storage: RetentionStorage = {
    listObjects: async (prefix) => objects.filter((o) => o.key.startsWith(prefix) && !removed.includes(o.key)),
    removeObject: async (key) => {
      if (failKeys.includes(key)) throw new Error("boom");
      removed.push(key);
    },
  };
  return { storage, removed };
}

async function addDocument(jobId: string, key: string, sourceColumn: "resume_optimization_id" | "cover_letter_id", sourceId: string, kind: string) {
  await t.adminSql.unsafe(
    `INSERT INTO generated_documents (user_id, job_id, kind, format, ${sourceColumn}, object_key, byte_size, content_hash, renderer_version, download_filename)
     VALUES ($1, $2, $3, 'pdf', $4, $5, 10, $6, 'r1', 'f.pdf')`,
    [USER, jobId, kind, sourceId, key, `hash-${key}`]
  );
}

async function terminalApplication(jobId: string, terminalDaysAgo: number) {
  const app = await createApplication(t.db, USER, { jobId });
  await t.adminSql`UPDATE applications SET status = 'rejected', terminal_at = ${new Date(NOW.getTime() - terminalDaysAgo * DAY)} WHERE id = ${app.id}`;
  return app;
}

const countFor = async (table: string, jobId: string) =>
  (await t.adminSql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE job_id = $1`, [jobId]))[0].n as number;

describe("runRetentionSweep", () => {
  it("does nothing when disabled", async () => {
    const { storage, removed } = fakeStorage([{ key: `${USER}/x.pdf`, lastModified: new Date(0) }]);
    const r = await runRetentionSweep({ db: t.db, storage, userId: USER, retentionDays: 0, now: NOW });
    expect(r.status).toBe("disabled");
    expect(removed).toEqual([]);
  });

  it("purges exactly the due job's rows and objects, keeps another job's, and records it", async () => {
    const due = await seedJobWithDocuments(t.adminSql, USER, { title: "Data Engineer" });
    const kept = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    await addDocument(due.jobId, `${USER}/due-resume.pdf`, "resume_optimization_id", due.resumeId, "resume");
    await addDocument(due.jobId, `${USER}/due-letter.pdf`, "cover_letter_id", due.coverLetterId, "cover_letter");
    await addDocument(kept.jobId, `${USER}/kept.pdf`, "resume_optimization_id", kept.resumeId, "resume");
    const app = await terminalApplication(due.jobId, 31);
    await terminalApplication(kept.jobId, 5);

    const { storage, removed } = fakeStorage();
    const r = await runRetentionSweep({ db: t.db, storage, userId: USER, retentionDays: 30, now: NOW });

    expect(r).toMatchObject({ status: "completed", purgedApplications: 1, deletedObjects: 2, failedObjectDeletes: 0 });
    expect(removed.sort()).toEqual([`${USER}/due-letter.pdf`, `${USER}/due-resume.pdf`]);
    for (const table of ["generated_documents", "resume_optimizations", "application_pitches", "cover_letters", "interview_preparations"]) {
      expect(await countFor(table, due.jobId), table).toBe(0);
      expect(await countFor(table, kept.jobId), table).toBeGreaterThan(0);
    }
    const [row] = await t.adminSql`SELECT retention_purged_at, resume_optimization_id, feature_snapshot FROM applications WHERE id = ${app.id}`;
    expect(row.retention_purged_at).toEqual(NOW);
    expect(row.feature_snapshot.match.overallScore).toBe(78);
    const [event] = await t.adminSql`SELECT detail FROM application_events WHERE application_id = ${app.id} AND type = 'documents_purged'`;
    expect(event.detail).toEqual({ generatedDocuments: 2, resumeOptimizations: 1, applicationPitches: 1, coverLetters: 1, interviewPreparations: 1 });
  });

  it("does not purge the same application twice", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await terminalApplication(s.jobId, 31);
    await runRetentionSweep({ db: t.db, storage: fakeStorage().storage, userId: USER, retentionDays: 30, now: NOW });
    const second = await runRetentionSweep({ db: t.db, storage: fakeStorage().storage, userId: USER, retentionDays: 30, now: NOW });
    expect(second.purgedApplications).toBe(0);
  });

  it("skips an application row locked by another transaction", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const app = await terminalApplication(s.jobId, 31);
    const locker = await t.adminSql.reserve();
    try {
      await locker`BEGIN`;
      await locker`SELECT id FROM applications WHERE id = ${app.id} FOR UPDATE`;
      const r = await runRetentionSweep({ db: t.db, storage: fakeStorage().storage, userId: USER, retentionDays: 30, now: NOW });
      expect(r.purgedApplications).toBe(0);
    } finally {
      await locker`ROLLBACK`;
      locker.release();
    }
    expect(await countFor("resume_optimizations", s.jobId)).toBe(1);
  });

  it("counts a failed object removal and leaves the object for the orphan sweep", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await addDocument(s.jobId, `${USER}/stuck.pdf`, "resume_optimization_id", s.resumeId, "resume");
    await terminalApplication(s.jobId, 31);
    const r = await runRetentionSweep({ db: t.db, storage: fakeStorage([], [`${USER}/stuck.pdf`]).storage, userId: USER, retentionDays: 30, now: NOW });
    expect(r).toMatchObject({ purgedApplications: 1, deletedObjects: 0, failedObjectDeletes: 1 });
  });

  it("orphan sweep removes unreferenced objects older than 24h and keeps referenced or recent ones", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await addDocument(s.jobId, `${USER}/referenced.pdf`, "resume_optimization_id", s.resumeId, "resume");
    const { storage, removed } = fakeStorage([
      { key: `${USER}/referenced.pdf`, lastModified: new Date(NOW.getTime() - 5 * DAY) },
      { key: `${USER}/orphan-old.pdf`, lastModified: new Date(NOW.getTime() - 2 * DAY) },
      { key: `${USER}/orphan-new.pdf`, lastModified: new Date(NOW.getTime() - 60_000) },
    ]);
    const r = await runRetentionSweep({ db: t.db, storage, userId: USER, retentionDays: 30, now: NOW });
    expect(removed).toEqual([`${USER}/orphan-old.pdf`]);
    expect(r.orphanObjectsDeleted).toBe(1);
  });
});
```

Run: `pnpm --filter @ai-career/applications test -- runRetentionSweep`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `runRetentionSweep.ts`**

```ts
import { and, eq, isNotNull } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { isDueForPurge, planOrphanSweep, planRetention, type StoredObject } from "./planRetention";

const {
  applications, applicationEvents, generatedDocuments, resumeOptimizations, applicationPitches, coverLetters, interviewPreparations,
} = schema;

export interface RetentionStorage {
  listObjects(prefix: string): Promise<StoredObject[]>;
  removeObject(key: string): Promise<void>;
}

export interface RetentionSweepResult {
  status: "disabled" | "completed";
  purgedApplications: number;
  deletedRows: number;
  deletedObjects: number;
  orphanObjectsDeleted: number;
  failedObjectDeletes: number;
}

interface PurgeOutcome {
  objectKeys: string[];
  rowCount: number;
}

/**
 * One application, one transaction (design §4.5). FOR UPDATE SKIP LOCKED makes concurrent sweeps skip
 * each other's rows (no session advisory lock -- unreliable on a pooled connection). The due check is
 * repeated under the lock. Rows go first; objects are removed by the caller after commit, so a crash
 * can only leave objects without rows, which the orphan sweep collects.
 */
async function purgeOne(tx: DbClient, applicationId: string, now: Date, retentionDays: number): Promise<PurgeOutcome | null> {
  const [app] = await tx
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .for("update", { skipLocked: true });
  if (!app || !isDueForPurge(app, now, retentionDays)) return null;
  const jobId = app.jobId!;

  const docs = await tx.delete(generatedDocuments).where(eq(generatedDocuments.jobId, jobId)).returning({ objectKey: generatedDocuments.objectKey });
  const resumes = await tx.delete(resumeOptimizations).where(eq(resumeOptimizations.jobId, jobId)).returning({ id: resumeOptimizations.id });
  const pitches = await tx.delete(applicationPitches).where(eq(applicationPitches.jobId, jobId)).returning({ id: applicationPitches.id });
  const letters = await tx.delete(coverLetters).where(eq(coverLetters.jobId, jobId)).returning({ id: coverLetters.id });
  const preps = await tx.delete(interviewPreparations).where(eq(interviewPreparations.jobId, jobId)).returning({ id: interviewPreparations.id });

  const counts = {
    generatedDocuments: docs.length,
    resumeOptimizations: resumes.length,
    applicationPitches: pitches.length,
    coverLetters: letters.length,
    interviewPreparations: preps.length,
  };
  await tx.update(applications).set({ retentionPurgedAt: now, updatedAt: now }).where(eq(applications.id, applicationId));
  await tx.insert(applicationEvents).values({ applicationId, type: "documents_purged", occurredAt: now, detail: counts });

  return { objectKeys: docs.map((d) => d.objectKey), rowCount: Object.values(counts).reduce((a, b) => a + b, 0) };
}

export async function runRetentionSweep(opts: {
  db: DbClient;
  storage: RetentionStorage;
  userId: string;
  retentionDays: number;
  now?: Date;
}): Promise<RetentionSweepResult> {
  const { db, storage, userId, retentionDays } = opts;
  const now = opts.now ?? new Date();
  const result: RetentionSweepResult = {
    status: "completed", purgedApplications: 0, deletedRows: 0, deletedObjects: 0, orphanObjectsDeleted: 0, failedObjectDeletes: 0,
  };
  if (retentionDays <= 0) return { ...result, status: "disabled" };

  const removeAll = async (keys: string[], counter: "deletedObjects" | "orphanObjectsDeleted") => {
    for (const key of keys) {
      try {
        await storage.removeObject(key);
        result[counter]++;
      } catch {
        result.failedObjectDeletes++;
      }
    }
  };

  const candidates = await withUserContext(db, userId, (tx) =>
    tx
      .select({ id: applications.id, jobId: applications.jobId, terminalAt: applications.terminalAt, retentionPurgedAt: applications.retentionPurgedAt })
      .from(applications)
      .where(and(isNotNull(applications.jobId), isNotNull(applications.terminalAt)))
  );

  for (const candidate of planRetention({ candidates, now, retentionDays })) {
    const outcome = await withUserContext(db, userId, (tx) => purgeOne(tx, candidate.id, now, retentionDays));
    if (!outcome) continue;
    result.purgedApplications++;
    result.deletedRows += outcome.rowCount;
    await removeAll(outcome.objectKeys, "deletedObjects");
  }

  const objects = await storage.listObjects(`${userId}/`);
  if (objects.length > 0) {
    const referenced = await withUserContext(db, userId, (tx) => tx.select({ key: generatedDocuments.objectKey }).from(generatedDocuments));
    await removeAll(planOrphanSweep({ objects, referencedKeys: new Set(referenced.map((r) => r.key)), now }), "orphanObjectsDeleted");
  }

  return result;
}
```

Run: `pnpm --filter @ai-career/applications test -- runRetentionSweep`
Expected: PASS (6 tests). If the locked-row test hangs rather than skipping, `.for("update", { skipLocked: true })` did not render `SKIP LOCKED`. Check the SQL with `.toSQL()` and fix before continuing.

- [ ] **Step 5: Export, full checks, commit**

Append to `packages/applications/src/index.ts`:
```ts
export { runRetentionSweep, type RetentionStorage, type RetentionSweepResult } from "./retention/runRetentionSweep";
```

Run: `pnpm --filter @ai-career/applications test && pnpm --filter @ai-career/applications typecheck && pnpm --filter @ai-career/applications lint && pnpm --filter @ai-career/config typecheck && pnpm --filter @ai-career/storage lint`
```bash
git add packages/applications packages/config packages/storage
git commit -m "feat(applications): retention sweep with rows-then-objects purge and orphan sweep"
```

---

### Task 9: Maintenance worker and `pnpm retention:run`

**Files:**
- Create: `services/maintenance-worker/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
- Create: `services/maintenance-worker/src/queue.ts`, `src/storageAdapter.ts`, `src/worker.ts`, `src/main.ts`, `src/runOnce.ts`
- Test: `services/maintenance-worker/src/worker.test.ts`
- Modify: root `package.json`

**Interfaces:**
- Consumes: `runRetentionSweep`, `RetentionStorage` (Task 8); `listGeneratedDocuments`, `deleteGeneratedDocument`, `createStorageClient` (storage).
- Produces: `MAINTENANCE_QUEUE_NAME = "maintenance"`, `RETENTION_JOB_NAME = "retention"`, `RETENTION_SCHEDULER_ID = "retention-daily"`, `RETENTION_EVERY_MS = 86_400_000`, `createRetentionStorage(client): RetentionStorage`, `createMaintenanceWorker(deps): Worker`, `scheduleRetention(queue): Promise<void>`

- [ ] **Step 1: Scaffold**

`services/maintenance-worker/package.json`:
```json
{
  "name": "@ai-career/maintenance-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "dotenv -e ../../.env -- tsx src/main.ts",
    "dev": "dotenv -e ../../.env -- tsx watch src/main.ts",
    "retention:run": "dotenv -e ../../.env -- tsx src/runOnce.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/applications": "workspace:*",
    "@ai-career/config": "workspace:*",
    "@ai-career/db": "workspace:*",
    "@ai-career/storage": "workspace:*",
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.0",
    "minio": "^8.0.2"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "dotenv-cli": "^7.4.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```
`tsconfig.json`: copy `services/matching-worker/tsconfig.json` with `"include": ["src"]`. `eslint.config.mjs`: same two lines as `services/matching-worker/eslint.config.mjs`. `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { fileParallelism: false, testTimeout: 20_000 } });
```
Add to root `package.json` scripts:
```json
"retention:run": "pnpm --filter @ai-career/maintenance-worker retention:run"
```
Run: `pnpm install`

- [ ] **Step 2: Write `queue.ts` and `storageAdapter.ts`**

`src/queue.ts`:
```ts
export const MAINTENANCE_QUEUE_NAME = "maintenance";
export const RETENTION_JOB_NAME = "retention";
export const RETENTION_SCHEDULER_ID = "retention-daily";
export const RETENTION_EVERY_MS = 86_400_000;
```

`src/storageAdapter.ts`:
```ts
import type { Client } from "minio";
import { deleteGeneratedDocument, listGeneratedDocuments } from "@ai-career/storage";
import type { RetentionStorage } from "@ai-career/applications";

/** S3 DeleteObject is idempotent, so removing an already-missing key succeeds. */
export function createRetentionStorage(client: Client): RetentionStorage {
  return {
    listObjects: (prefix) => listGeneratedDocuments(client, prefix),
    removeObject: (key) => deleteGeneratedDocument(client, key),
  };
}
```

- [ ] **Step 3: Write the failing worker test**

`src/worker.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { openTestDb, type TestDb } from "@ai-career/applications/testing";
import type { RetentionStorage } from "@ai-career/applications";
import { createMaintenanceWorker, scheduleRetention } from "./worker";
import { RETENTION_JOB_NAME, RETENTION_SCHEDULER_ID } from "./queue";

const USER = "00000000-0000-0000-0000-0000000009a6";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `maintenance-test-${randomUUID()}`;
const storage: RetentionStorage = { listObjects: async () => [], removeObject: async () => {} };

let t: TestDb;
let queue: Queue;
let events: QueueEvents;
let worker: Worker;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createMaintenanceWorker({ connection, db: t.db, storage, userId: USER, retentionDays: 30, queueName });
  await worker.waitUntilReady();
});
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await t.close();
});

describe("maintenance worker", () => {
  it("runs the retention sweep for a retention job and returns its counts", async () => {
    const job = await queue.add(RETENTION_JOB_NAME, {});
    const result = await job.waitUntilFinished(events, 15_000);
    expect(result).toMatchObject({ status: "completed", purgedApplications: 0 });
  });

  it("fails an unknown job name without retrying", async () => {
    const job = await queue.add("mystery", {}, { attempts: 3 });
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/unknown maintenance job/);
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
  });

  it("registers the daily retention scheduler idempotently", async () => {
    await scheduleRetention(queue);
    await scheduleRetention(queue);
    const ids = (await queue.getJobSchedulers()).map((s) => s.id ?? s.key);
    expect(ids.filter((id) => id === RETENTION_SCHEDULER_ID)).toHaveLength(1);
  });
});
```
Run: `pnpm --filter @ai-career/maintenance-worker test` → FAIL, module not found.

- [ ] **Step 4: Implement `worker.ts`**

```ts
import { Worker, UnrecoverableError, type ConnectionOptions, type Queue } from "bullmq";
import type { DbClient } from "@ai-career/db";
import { runRetentionSweep, type RetentionStorage, type RetentionSweepResult } from "@ai-career/applications";
import { MAINTENANCE_QUEUE_NAME, RETENTION_EVERY_MS, RETENTION_JOB_NAME, RETENTION_SCHEDULER_ID } from "./queue";

export interface MaintenanceWorkerDeps {
  connection: ConnectionOptions;
  db: DbClient;
  storage: RetentionStorage;
  userId: string;
  retentionDays: number;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/** Holds no domain logic: dispatches by job name to packages/applications. Concurrency 1 (personal tool). */
export function createMaintenanceWorker(deps: MaintenanceWorkerDeps): Worker<unknown, RetentionSweepResult> {
  return new Worker<unknown, RetentionSweepResult>(
    deps.queueName ?? MAINTENANCE_QUEUE_NAME,
    async (job) => {
      if (job.name !== RETENTION_JOB_NAME) throw new UnrecoverableError(`unknown maintenance job: ${job.name}`);
      return runRetentionSweep({ db: deps.db, storage: deps.storage, userId: deps.userId, retentionDays: deps.retentionDays });
    },
    { connection: deps.connection, concurrency: 1 }
  );
}

/** Upsert is idempotent: re-running on every boot keeps exactly one daily scheduler. */
export async function scheduleRetention(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(RETENTION_SCHEDULER_ID, { every: RETENTION_EVERY_MS }, { name: RETENTION_JOB_NAME, data: {} });
}
```
Run: `pnpm --filter @ai-career/maintenance-worker test` → PASS (3 tests).

- [ ] **Step 5: Write `main.ts` and `runOnce.ts`**

`src/main.ts`:
```ts
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { createRetentionStorage } from "./storageAdapter";
import { createMaintenanceWorker, scheduleRetention } from "./worker";
import { MAINTENANCE_QUEUE_NAME } from "./queue";

// Structured logs only: ids, counts and error classes -- never document or note content (CLAUDE.md §9).
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
const safeErrorLabel = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, { connection });
  const storage = createRetentionStorage(createStorageClient(env));

  const worker = createMaintenanceWorker({ connection, db, storage, userId: env.DEFAULT_USER_ID, retentionDays: env.RETENTION_DAYS });
  worker.on("completed", (job, result) => log("maintenance_completed", { jobId: job.id, name: job.name, ...result }));
  worker.on("failed", (job, error) => log("maintenance_failed", { jobId: job?.id, name: job?.name, error: safeErrorLabel(error) }));
  await scheduleRetention(queue);
  log("worker_started", { retentionDays: env.RETENTION_DAYS });

  const shutdown = async () => {
    await worker.close();
    await queue.close();
    await connection.quit();
    await closeDbClient(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log("worker_crashed", { error: safeErrorLabel(error) });
  process.exit(1);
});
```

`src/runOnce.ts`:
```ts
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { runRetentionSweep } from "@ai-career/applications";
import { createRetentionStorage } from "./storageAdapter";

/** `pnpm retention:run`: one sweep now, same code path as the daily job. Prints counts only. */
async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await runRetentionSweep({
      db, storage: createRetentionStorage(createStorageClient(env)), userId: env.DEFAULT_USER_ID, retentionDays: env.RETENTION_DAYS,
    });
    console.log(JSON.stringify({ event: "retention_run", ...result }));
  } finally {
    await closeDbClient(db);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ event: "retention_run_failed", error: error instanceof Error ? error.name : "unknown" }));
  process.exit(1);
});
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @ai-career/maintenance-worker typecheck && pnpm --filter @ai-career/maintenance-worker lint && pnpm retention:run`
Expected: typecheck/lint clean; `retention:run` prints `{"event":"retention_run","status":"completed",...}` against the dev DB (0 purged is fine).

```bash
git add services/maintenance-worker package.json pnpm-lock.yaml
git commit -m "feat(maintenance-worker): daily retention sweep and retention:run script"
```

---

### Task 10: API routes: create, list, for-job; match route `applicationId`

**Files:**
- Modify: `apps/web/package.json` (add `"@ai-career/applications": "workspace:*"`), then `pnpm install`
- Create: `apps/web/src/lib/applications/serializeApplication.ts` (+ `.test.ts`), `apps/web/src/lib/applications/errorResponse.ts`
- Create: `apps/web/src/app/api/applications/route.ts` (+ `route.test.ts`)
- Create: `apps/web/src/app/api/applications/for-job/[jobId]/route.ts` (+ `route.test.ts`)
- Modify: `apps/web/src/app/api/matches/[jobId]/route.ts` (+ its existing test file)
- Modify: `apps/web/src/test/jobsDb.ts`

**Interfaces:**
- Consumes: `createApplication`, `listApplications`, `getApplicationForJob`, `listDocumentOptions`, `CreateApplicationBodySchema`, `APPLICATION_STATUSES`, `ApplicationError`, `todayUtc`, `ApplicationRow`, `ApplicationEventRow`.
- Produces:
  - `ApplicationView` (JSON): `{ id, jobId, companyName, jobTitle, jobUrl, status, statusChangedAt, appliedAt, followUpAt, recruiterName, recruiterContact, salaryNotes, notes, resumeOptimizationId, applicationPitchId, coverLetterId, terminalAt, retentionPurgedAt, external, snapshotSummary: { matchOverall: number|null; atsOverall: number|null; documents: { resume: number|null; pitch: number|null; coverLetter: number|null } }, createdAt }`
  - `ApplicationEventView`: `{ id, type, occurredAt, fromStatus, toStatus, detail }`
  - `toApplicationView(row)`, `toEventView(row)`, `applicationErrorResponse(error): NextResponse | null`
  - Test helper `insertApplication(admin, userId, opts)`
  - `GET /api/matches/[jobId]` adds `applicationId: string | null`

- [ ] **Step 1: Test helpers**

In `apps/web/src/test/jobsDb.ts`, make `wipeJobData` start with:
```ts
  await adminSql`DELETE FROM applications WHERE user_id = ${userId}`;
```
and append:
```ts
export async function insertApplication(
  adminSql: postgres.Sql,
  userId: string,
  opts: { jobId?: string | null; companyName?: string; status?: string; terminal?: boolean; followUpAt?: string | null; appliedAt?: string } = {}
): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, follow_up_at,
                              feature_snapshot, terminal_at)
    VALUES (${userId}, ${opts.jobId ?? null}, ${opts.companyName ?? "Acme"}, 'Data Engineer', ${opts.status ?? "applied"}, now(),
            ${opts.appliedAt ?? "2026-09-30"}, ${opts.followUpAt ?? null},
            '{"snapshotVersion":1,"external":false,"match":{"overallScore":78},"ats":{"overallScore":82},"documents":{"resume":{"version":3},"pitch":null,"coverLetter":null}}'::jsonb,
            ${opts.terminal ? new Date() : null}::timestamptz)
    RETURNING id`;
  await adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, to_status)
                 VALUES (${userId}, ${row.id}, 'status_change', now(), ${opts.status ?? "applied"})`;
  return row.id as string;
}
```

- [ ] **Step 2: Serializer and error mapping (test first)**

`apps/web/src/lib/applications/serializeApplication.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toApplicationView, toEventView } from "./serializeApplication";

const base = {
  id: "a1", userId: "u", jobId: "j1", companyName: "Acme", jobTitle: "DE", jobUrl: null, status: "applied" as const,
  statusChangedAt: new Date("2026-09-30T10:00:00Z"), appliedAt: "2026-09-30", followUpAt: null, recruiterName: null,
  recruiterContact: null, salaryNotes: null, notes: null, resumeOptimizationId: "r1", applicationPitchId: null, coverLetterId: null,
  terminalAt: null, retentionPurgedAt: null, createdAt: new Date("2026-09-30T10:00:00Z"), updatedAt: new Date("2026-09-30T10:00:00Z"),
};

describe("toApplicationView", () => {
  it("summarizes the snapshot and serializes dates, omitting userId and the full snapshot", () => {
    const view = toApplicationView({
      ...base,
      featureSnapshot: { external: false, match: { overallScore: 78 }, ats: { overallScore: 82 }, documents: { resume: { version: 3 }, pitch: null, coverLetter: { version: 1 } } },
    });
    expect(view).toMatchObject({
      id: "a1", external: false, statusChangedAt: "2026-09-30T10:00:00.000Z",
      snapshotSummary: { matchOverall: 78, atsOverall: 82, documents: { resume: 3, pitch: null, coverLetter: 1 } },
    });
    expect(view).not.toHaveProperty("userId");
    expect(view).not.toHaveProperty("featureSnapshot");
  });

  it("tolerates an external or unexpected snapshot shape", () => {
    expect(toApplicationView({ ...base, jobId: null, featureSnapshot: { external: true, match: null, ats: null, documents: null } }).snapshotSummary)
      .toEqual({ matchOverall: null, atsOverall: null, documents: { resume: null, pitch: null, coverLetter: null } });
    expect(toApplicationView({ ...base, featureSnapshot: {} }).external).toBe(false);
  });
});

describe("toEventView", () => {
  it("serializes an event", () => {
    expect(toEventView({ id: "e1", userId: "u", applicationId: "a1", type: "note", occurredAt: new Date("2026-10-01T00:00:00Z"),
      fromStatus: null, toStatus: null, detail: { text: "x" }, createdAt: new Date() }))
      .toEqual({ id: "e1", type: "note", occurredAt: "2026-10-01T00:00:00.000Z", fromStatus: null, toStatus: null, detail: { text: "x" } });
  });
});
```

`apps/web/src/lib/applications/serializeApplication.ts`:
```ts
import type { ApplicationEventRow, ApplicationRow } from "@ai-career/applications";

export interface ApplicationView {
  id: string;
  jobId: string | null;
  companyName: string;
  jobTitle: string;
  jobUrl: string | null;
  status: ApplicationRow["status"];
  statusChangedAt: string;
  appliedAt: string;
  followUpAt: string | null;
  recruiterName: string | null;
  recruiterContact: string | null;
  salaryNotes: string | null;
  notes: string | null;
  resumeOptimizationId: string | null;
  applicationPitchId: string | null;
  coverLetterId: string | null;
  terminalAt: string | null;
  retentionPurgedAt: string | null;
  external: boolean;
  snapshotSummary: {
    matchOverall: number | null;
    atsOverall: number | null;
    documents: { resume: number | null; pitch: number | null; coverLetter: number | null };
  };
  createdAt: string;
}

export interface ApplicationEventView {
  id: string;
  type: ApplicationEventRow["type"];
  occurredAt: string;
  fromStatus: string | null;
  toStatus: string | null;
  detail: unknown;
}

type LooseSnapshot = {
  external?: boolean;
  match?: { overallScore?: number | null } | null;
  ats?: { overallScore?: number | null } | null;
  documents?: Record<"resume" | "pitch" | "coverLetter", { version?: number } | null> | null;
};

const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** The full snapshot stays server-side (Phase 10 input); the UI gets a one-line summary. */
export function toApplicationView(row: ApplicationRow): ApplicationView {
  const s = (row.featureSnapshot ?? {}) as LooseSnapshot;
  return {
    id: row.id,
    jobId: row.jobId,
    companyName: row.companyName,
    jobTitle: row.jobTitle,
    jobUrl: row.jobUrl,
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    appliedAt: row.appliedAt,
    followUpAt: row.followUpAt,
    recruiterName: row.recruiterName,
    recruiterContact: row.recruiterContact,
    salaryNotes: row.salaryNotes,
    notes: row.notes,
    resumeOptimizationId: row.resumeOptimizationId,
    applicationPitchId: row.applicationPitchId,
    coverLetterId: row.coverLetterId,
    terminalAt: row.terminalAt?.toISOString() ?? null,
    retentionPurgedAt: row.retentionPurgedAt?.toISOString() ?? null,
    external: s.external === true,
    snapshotSummary: {
      matchOverall: numOrNull(s.match?.overallScore),
      atsOverall: numOrNull(s.ats?.overallScore),
      documents: {
        resume: numOrNull(s.documents?.resume?.version),
        pitch: numOrNull(s.documents?.pitch?.version),
        coverLetter: numOrNull(s.documents?.coverLetter?.version),
      },
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export function toEventView(row: ApplicationEventRow): ApplicationEventView {
  return {
    id: row.id, type: row.type, occurredAt: row.occurredAt.toISOString(), fromStatus: row.fromStatus, toStatus: row.toStatus, detail: row.detail,
  };
}
```

`apps/web/src/lib/applications/errorResponse.ts`:
```ts
import { NextResponse } from "next/server";
import { ApplicationError } from "@ai-career/applications";

/** Maps a domain error class to its HTTP answer; null means "not ours, rethrow". */
export function applicationErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof ApplicationError)) return null;
  switch (error.errorClass) {
    case "job_not_found":
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    case "not_found":
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    case "already_applied":
      return NextResponse.json({ error: "You already have an application for this job" }, { status: 409 });
    case "same_status":
      return NextResponse.json({ error: "The application already has this status" }, { status: 409 });
    case "document_mismatch":
      return NextResponse.json({ error: "A selected document does not belong to this job" }, { status: 422 });
  }
}
```

Run: `pnpm --filter web exec vitest run src/lib/applications` → PASS.

- [ ] **Step 3: Write the failing collection-route test**

`apps/web/src/app/api/applications/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertApplication, insertCoverLetter } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b1",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b1";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET, POST } = await import("./route");
const post = (body: string) =>
  POST(new Request("http://localhost/api/applications", { method: "POST", body, headers: { "Content-Type": "application/json" } }));
const get = (query = "") => GET(new Request(`http://localhost/api/applications${query}`));

describe("POST /api/applications", () => {
  it("returns 400 for bad JSON and for a body with neither jobId nor external", async () => {
    expect((await post("{nope")).status).toBe(400);
    const res = await post("{}");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/jobId/);
  });

  it("creates an ingested application (201), then 409 on a second one", async () => {
    const jobId = await insertJob(admin, USER, {});
    const res = await post(JSON.stringify({ jobId }));
    expect(res.status).toBe(201);
    expect((await res.json()).application).toMatchObject({ jobId, companyName: "Acme", status: "applied", external: false });
    expect((await post(JSON.stringify({ jobId }))).status).toBe(409);
  });

  it("returns 404 for an unknown job and 422 for another job's document", async () => {
    expect((await post(JSON.stringify({ jobId: "11111111-1111-4111-8111-111111111111" }))).status).toBe(404);
    const jobId = await insertJob(admin, USER, { title: "Data Engineer" });
    const otherJob = await insertJob(admin, USER, { title: "Analytics Engineer" });
    const letter = await insertCoverLetter(admin, USER, otherJob, {});
    expect((await post(JSON.stringify({ jobId, coverLetterId: letter }))).status).toBe(422);
  });

  it("creates an external application", async () => {
    const res = await post(JSON.stringify({ external: { companyName: "Globex", jobTitle: "Analyst", jobUrl: "https://globex.example/1" } }));
    expect(res.status).toBe(201);
    expect((await res.json()).application).toMatchObject({ jobId: null, external: true, jobUrl: "https://globex.example/1" });
  });
});

describe("GET /api/applications", () => {
  it("lists applications with a due count, filters by status and due, and 400s an unknown status", async () => {
    await insertApplication(admin, USER, { companyName: "A", followUpAt: "2020-01-01" });
    await insertApplication(admin, USER, { companyName: "B", status: "rejected", terminal: true, followUpAt: "2020-01-01" });
    const all = await (await get()).json();
    expect(all.applications).toHaveLength(2);
    expect(all.dueCount).toBe(1);
    expect((await (await get("?status=rejected")).json()).applications.map((a: { companyName: string }) => a.companyName)).toEqual(["B"]);
    expect((await (await get("?due=1")).json()).applications.map((a: { companyName: string }) => a.companyName)).toEqual(["A"]);
    expect((await get("?status=ghosted")).status).toBe(400);
  });
});
```
Run: `pnpm --filter web exec vitest run src/app/api/applications/route.test.ts` → FAIL, module not found.

- [ ] **Step 4: Implement the collection route**

`apps/web/src/app/api/applications/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import {
  APPLICATION_STATUSES, CreateApplicationBodySchema, createApplication, listApplications, todayUtc, type ApplicationStatus,
} from "@ai-career/applications";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { toApplicationView } from "../../../lib/applications/serializeApplication";
import { applicationErrorResponse } from "../../../lib/applications/errorResponse";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  if (status !== null && !(APPLICATION_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Unknown status" }, { status: 400 });
  }
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await listApplications(db, env.DEFAULT_USER_ID, {
      status: (status ?? undefined) as ApplicationStatus | undefined,
      dueOnly: params.get("due") === "1",
      today: todayUtc(new Date()),
    });
    return NextResponse.json({ applications: result.applications.map(toApplicationView), dueCount: result.dueCount });
  } finally {
    await closeDbClient(db);
  }
}

export async function POST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = CreateApplicationBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await createApplication(db, env.DEFAULT_USER_ID, parsed.data);
    return NextResponse.json({ application: toApplicationView(row) }, { status: 201 });
  } catch (error) {
    const mapped = applicationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
```
Run the test → PASS.

- [ ] **Step 5: for-job route (test first)**

`apps/web/src/app/api/applications/for-job/[jobId]/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertApplication, insertPitch } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b2",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b2";
let admin: postgres.Sql;
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");
const get = (jobId: string) => GET(new Request("http://localhost"), { params: Promise.resolve({ jobId }) });

describe("GET /api/applications/for-job/[jobId]", () => {
  it("404s a non-UUID", async () => {
    expect((await get("x")).status).toBe(404);
  });

  it("returns null plus document options before applying, and the application after", async () => {
    const jobId = await insertJob(admin, USER, {});
    const pitchId = await insertPitch(admin, USER, jobId, {});
    let body = await (await get(jobId)).json();
    expect(body.application).toBeNull();
    expect(body.documentOptions).toEqual({ resumes: [], pitches: [{ id: pitchId, version: 1, origin: "generated" }], coverLetters: [] });

    const appId = await insertApplication(admin, USER, { jobId });
    body = await (await get(jobId)).json();
    expect(body.application).toEqual({ id: appId, status: "applied", appliedAt: "2026-09-30" });
  });
});
```

`apps/web/src/app/api/applications/for-job/[jobId]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { getApplicationForJob, listDocumentOptions } from "@ai-career/applications";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const application = await getApplicationForJob(db, env.DEFAULT_USER_ID, jobId);
    const documentOptions = await listDocumentOptions(db, env.DEFAULT_USER_ID, jobId);
    return NextResponse.json({
      application: application && { id: application.id, status: application.status, appliedAt: application.appliedAt },
      documentOptions,
    });
  } finally {
    await closeDbClient(db);
  }
}
```
Run: `pnpm --filter web exec vitest run src/app/api/applications` → PASS.

- [ ] **Step 6: `applicationId` on the match route (test first)**

Find the existing GET test: `ls "apps/web/src/app/api/matches/[jobId]"`. In its test file, add a test using that file's own USER/admin/helpers:
```ts
  it("includes the job's applicationId (null when not applied)", async () => {
    const jobId = await insertJob(admin, USER, {});
    const goalId = await insertCareerGoal(admin, USER);
    await insertMatch(admin, USER, jobId, goalId);
    expect((await (await GET(new Request("http://localhost"), { params: Promise.resolve({ jobId }) })).json()).applicationId).toBeNull();
    const appId = await insertApplication(admin, USER, { jobId });
    expect((await (await GET(new Request("http://localhost"), { params: Promise.resolve({ jobId }) })).json()).applicationId).toBe(appId);
  });
```
(Import `insertApplication`, `insertCareerGoal` and `insertMatch` from the test helpers if the file does not already.) Run it → FAIL.

In `apps/web/src/app/api/matches/[jobId]/route.ts` GET, replace the final `return NextResponse.json({ job, match: toMatchView(matchRow) });` with:
```ts
      const [application] = await tx
        .select({ id: schema.applications.id })
        .from(schema.applications)
        .where(eq(schema.applications.jobId, jobId))
        .limit(1);
      return NextResponse.json({ job, match: toMatchView(matchRow), applicationId: application?.id ?? null });
```
Run → PASS.

- [ ] **Step 7: Commit**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): application create/list/for-job routes and applicationId on match detail"
```

---

### Task 11: API routes: detail, edit, delete, status, events

**Files:**
- Create: `apps/web/src/app/api/applications/[id]/route.ts` (+ `route.test.ts`)
- Create: `apps/web/src/app/api/applications/[id]/status/route.ts` (+ `route.test.ts`)
- Create: `apps/web/src/app/api/applications/[id]/events/route.ts` (+ `route.test.ts`)

**Interfaces:**
- Consumes: `getApplication`, `updateApplication`, `deleteApplication`, `changeStatus`, `addEvent`, `UpdateApplicationBodySchema`, `ChangeStatusBodySchema`, `UserEventBodySchema`; Task 10 serializers and `applicationErrorResponse`.
- Produces:
  - `GET /api/applications/[id]` → `{ application: ApplicationView, events: ApplicationEventView[] }`
  - `PATCH` → `{ application }`
  - `DELETE` → 204
  - `POST .../status` → `{ application }`
  - `POST .../events` → 201 `{ event }`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/app/api/applications/[id]/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertApplication } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b3",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b3";
const MISSING = "11111111-1111-4111-8111-111111111111";
let admin: postgres.Sql;
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET, PATCH, DELETE } = await import("./route");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: string) =>
  PATCH(new Request("http://localhost", { method: "PATCH", body, headers: { "Content-Type": "application/json" } }), ctx(id));

describe("/api/applications/[id]", () => {
  it("GET returns the application and its events, 404 for unknown or non-UUID ids", async () => {
    const id = await insertApplication(admin, USER, {});
    const body = await (await GET(new Request("http://localhost"), ctx(id))).json();
    expect(body.application).toMatchObject({ id, snapshotSummary: { matchOverall: 78, atsOverall: 82 } });
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["status_change"]);
    expect((await GET(new Request("http://localhost"), ctx(MISSING))).status).toBe(404);
    expect((await GET(new Request("http://localhost"), ctx("nope"))).status).toBe(404);
  });

  it("PATCH edits fields, 400s bad input, 404s unknown", async () => {
    const id = await insertApplication(admin, USER, {});
    const res = await patch(id, JSON.stringify({ recruiterName: "Sam", followUpAt: "2026-10-09" }));
    expect(res.status).toBe(200);
    expect((await res.json()).application).toMatchObject({ recruiterName: "Sam", followUpAt: "2026-10-09" });
    expect((await patch(id, JSON.stringify({}))).status).toBe(400);
    expect((await patch(id, JSON.stringify({ jobUrl: "ftp://x" }))).status).toBe(400);
    expect((await patch(MISSING, JSON.stringify({ notes: "x" }))).status).toBe(404);
  });

  it("DELETE removes it (204), then 404", async () => {
    const id = await insertApplication(admin, USER, {});
    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), ctx(id))).status).toBe(204);
    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), ctx(id))).status).toBe(404);
  });
});
```

`apps/web/src/app/api/applications/[id]/status/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertApplication } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b4",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b4";
let admin: postgres.Sql;
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const post = (id: string, body: string) =>
  POST(new Request("http://localhost", { method: "POST", body, headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id }) });

describe("POST /api/applications/[id]/status", () => {
  it("changes the status and sets terminalAt for a terminal status", async () => {
    const id = await insertApplication(admin, USER, {});
    const res = await post(id, JSON.stringify({ toStatus: "rejected", note: "Form email" }));
    expect(res.status).toBe(200);
    const { application } = await res.json();
    expect(application.status).toBe("rejected");
    expect(application.terminalAt).not.toBeNull();
  });

  it("409s the same status, 400s an unknown one, 404s an unknown application", async () => {
    const id = await insertApplication(admin, USER, {});
    expect((await post(id, JSON.stringify({ toStatus: "applied" }))).status).toBe(409);
    expect((await post(id, JSON.stringify({ toStatus: "ghosted" }))).status).toBe(400);
    expect((await post("11111111-1111-4111-8111-111111111111", JSON.stringify({ toStatus: "offer" }))).status).toBe(404);
  });
});
```

`apps/web/src/app/api/applications/[id]/events/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertApplication } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000009b5",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000009b5";
let admin: postgres.Sql;
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const post = (id: string, body: string) =>
  POST(new Request("http://localhost", { method: "POST", body, headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id }) });

describe("POST /api/applications/[id]/events", () => {
  it("logs an interview (201) and a snooze that moves the follow-up date", async () => {
    const id = await insertApplication(admin, USER, { followUpAt: "2026-10-01" });
    const res = await post(id, JSON.stringify({ type: "interview", detail: { round: 1, kind: "phone_screen", summary: "30 min" } }));
    expect(res.status).toBe(201);
    expect((await res.json()).event).toMatchObject({ type: "interview", detail: { round: 1, kind: "phone_screen" } });
    expect((await post(id, JSON.stringify({ type: "follow_up_snoozed", detail: { newFollowUpAt: "2026-10-08" } }))).status).toBe(201);
    const [row] = await admin`SELECT follow_up_at::text AS f FROM applications WHERE id = ${id}`;
    expect(row.f).toBe("2026-10-08");
  });

  it("400s system-only types, 404s unknown applications", async () => {
    const id = await insertApplication(admin, USER, {});
    expect((await post(id, JSON.stringify({ type: "status_change", detail: {} }))).status).toBe(400);
    expect((await post("11111111-1111-4111-8111-111111111111", JSON.stringify({ type: "note", detail: { text: "x" } }))).status).toBe(404);
  });
});
```

Run: `pnpm --filter web exec vitest run src/app/api/applications` → the three new files FAIL.

- [ ] **Step 2: Implement the three routes**

`apps/web/src/app/api/applications/[id]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { UpdateApplicationBodySchema, deleteApplication, getApplication, updateApplication } from "@ai-career/applications";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { toApplicationView, toEventView } from "../../../../lib/applications/serializeApplication";
import { applicationErrorResponse } from "../../../../lib/applications/errorResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Application not found" }, { status: 404 });
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const found = await getApplication(db, env.DEFAULT_USER_ID, id);
    if (!found) return notFound();
    return NextResponse.json({ application: toApplicationView(found.application), events: found.events.map(toEventView) });
  } finally {
    await closeDbClient(db);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = UpdateApplicationBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await updateApplication(db, env.DEFAULT_USER_ID, id, parsed.data);
    return NextResponse.json({ application: toApplicationView(row) });
  } catch (error) {
    const mapped = applicationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    return (await deleteApplication(db, env.DEFAULT_USER_ID, id)) ? new NextResponse(null, { status: 204 }) : notFound();
  } finally {
    await closeDbClient(db);
  }
}
```

`apps/web/src/app/api/applications/[id]/status/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { ChangeStatusBodySchema, changeStatus } from "@ai-career/applications";
import { readJsonBody } from "../../../../../lib/readJsonBody";
import { formatValidationError } from "../../../../../lib/formatValidationError";
import { toApplicationView } from "../../../../../lib/applications/serializeApplication";
import { applicationErrorResponse } from "../../../../../lib/applications/errorResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Application not found" }, { status: 404 });
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = ChangeStatusBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await changeStatus(db, env.DEFAULT_USER_ID, id, parsed.data);
    return NextResponse.json({ application: toApplicationView(row) });
  } catch (error) {
    const mapped = applicationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
```

`apps/web/src/app/api/applications/[id]/events/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { UserEventBodySchema, addEvent } from "@ai-career/applications";
import { readJsonBody } from "../../../../../lib/readJsonBody";
import { formatValidationError } from "../../../../../lib/formatValidationError";
import { toEventView } from "../../../../../lib/applications/serializeApplication";
import { applicationErrorResponse } from "../../../../../lib/applications/errorResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Application not found" }, { status: 404 });
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = UserEventBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const event = await addEvent(db, env.DEFAULT_USER_ID, id, parsed.data);
    return NextResponse.json({ event: toEventView(event) }, { status: 201 });
  } catch (error) {
    const mapped = applicationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
```

Run: `pnpm --filter web exec vitest run src/app/api/applications` → PASS.

- [ ] **Step 3: Commit**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
```bash
git add apps/web
git commit -m "feat(web): application detail, edit, delete, status and event routes"
```

---

### Task 12: Mark-as-applied panel on the match page

**Files:**
- Create: `apps/web/src/lib/applications/statusLabels.ts` (+ `statusLabels.test.ts`)
- Create: `apps/web/src/app/matches/[jobId]/ApplicationPanel.tsx` (+ `ApplicationPanel.test.tsx`)
- Modify: `apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx` (+ `MatchDetailClient.test.tsx`)

**Interfaces:**
- Consumes: `GET /api/applications/for-job/[jobId]`, `POST /api/applications`, `applicationId` on `GET /api/matches/[jobId]`.
- Produces: `STATUS_LABELS: Record<string,string>`, `STATUS_ORDER: string[]`, `TERMINAL_STATUS_SET: ReadonlySet<string>` (client-safe; no DB import); `<ApplicationPanel jobId>`.

- [ ] **Step 1: Status labels (test first)**

`apps/web/src/lib/applications/statusLabels.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { APPLICATION_STATUSES, TERMINAL_STATUSES } from "@ai-career/applications";
import { STATUS_LABELS, STATUS_ORDER, TERMINAL_STATUS_SET } from "./statusLabels";

// statusLabels is imported by client components, so it cannot import the DB-backed package itself;
// this test keeps the two lists in lockstep.
describe("statusLabels", () => {
  it("labels exactly the domain statuses, in order, with the same terminal set", () => {
    expect(STATUS_ORDER).toEqual([...APPLICATION_STATUSES]);
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...APPLICATION_STATUSES].sort());
    expect([...TERMINAL_STATUS_SET].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });
});
```

`apps/web/src/lib/applications/statusLabels.ts`:
```ts
export const STATUS_LABELS: Record<string, string> = {
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  accepted: "Accepted",
  declined: "Declined",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  no_response: "No response",
};
export const STATUS_ORDER = Object.keys(STATUS_LABELS);
export const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(["accepted", "declined", "rejected", "withdrawn", "no_response"]);
```
Run: `pnpm --filter web exec vitest run src/lib/applications/statusLabels.test.ts` → PASS.

- [ ] **Step 2: Write the failing panel test**

`apps/web/src/app/matches/[jobId]/ApplicationPanel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApplicationPanel } from "./ApplicationPanel";

beforeEach(() => vi.unstubAllGlobals());

const options = {
  resumes: [{ id: "r2", version: 2, origin: null }, { id: "r1", version: 1, origin: null }],
  pitches: [{ id: "p1", version: 1, origin: "user_edited" }],
  coverLetters: [],
};
const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => body } as Response);

describe("ApplicationPanel", () => {
  it("preselects the newest version of each document and posts the choice", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ application: { id: "a1", status: "applied", appliedAt: "2026-09-30" } }, true, 201)
        : json({ application: null, documentOptions: options })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationPanel jobId="j1" />);

    expect(await screen.findByLabelText(/resume version/i)).toHaveValue("r2");
    expect(screen.getByLabelText(/pitch version/i)).toHaveValue("p1");
    expect(screen.getByLabelText(/cover letter version/i)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /mark as applied/i }));

    expect(await screen.findByText(/applied on 2026-09-30/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open in tracker/i })).toHaveAttribute("href", "/applications/a1");
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ jobId: "j1", resumeOptimizationId: "r2", applicationPitchId: "p1", coverLetterId: null });
  });

  it("shows the existing application instead of the form", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ application: { id: "a1", status: "interviewing", appliedAt: "2026-09-01" }, documentOptions: options })));
    render(<ApplicationPanel jobId="j1" />);
    expect(await screen.findByText(/applied on 2026-09-01 · interviewing/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark as applied/i })).not.toBeInTheDocument();
  });

  it("shows the server's error message when creation fails", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "You already have an application for this job" }, false, 409) : json({ application: null, documentOptions: options })
    ));
    render(<ApplicationPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: /mark as applied/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/already have an application/i));
  });
});
```
Run: `pnpm --filter web exec vitest run "src/app/matches/\[jobId\]/ApplicationPanel.test.tsx"` → FAIL.

- [ ] **Step 3: Implement `ApplicationPanel.tsx`**

```tsx
"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { STATUS_LABELS } from "../../../lib/applications/statusLabels";

interface DocumentOption {
  id: string;
  version: number;
  origin: "generated" | "user_edited" | null;
}
interface ForJob {
  application: { id: string; status: string; appliedAt: string } | null;
  documentOptions: { resumes: DocumentOption[]; pitches: DocumentOption[]; coverLetters: DocumentOption[] };
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: ForJob };

const todayLocal = () => new Date().toISOString().slice(0, 10);
const optionLabel = (o: DocumentOption) => `v${o.version}${o.origin === "user_edited" ? " (edited)" : ""}`;

function VersionSelect({ label, id, options, value, onChange }: {
  label: string; id: string; options: DocumentOption[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="rounded border p-1">
        <option value="">None</option>
        {options.map((o) => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}
      </select>
    </label>
  );
}

/** Records which versions were actually sent (Phase 9). Newest versions are preselected; "None" is allowed. */
export function ApplicationPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [resumeId, setResumeId] = useState("");
  const [pitchId, setPitchId] = useState("");
  const [coverLetterId, setCoverLetterId] = useState("");
  const [appliedAt, setAppliedAt] = useState(todayLocal());
  const [followUpAt, setFollowUpAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    fetch(`/api/applications/for-job/${encodeURIComponent(jobId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json() as Promise<ForJob>;
      })
      .then((data) => {
        if (ignore) return;
        setState({ kind: "ready", data });
        setResumeId(data.documentOptions.resumes[0]?.id ?? "");
        setPitchId(data.documentOptions.pitches[0]?.id ?? "");
        setCoverLetterId(data.documentOptions.coverLetters[0]?.id ?? "");
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [jobId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== "ready") return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          resumeOptimizationId: resumeId || null,
          applicationPitchId: pitchId || null,
          coverLetterId: coverLetterId || null,
          appliedAt,
          followUpAt: followUpAt || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not record the application.");
        return;
      }
      const a = body.application;
      setState({ kind: "ready", data: { ...state.data, application: { id: a.id, status: a.status, appliedAt: a.appliedAt } } });
    } catch {
      setError("Could not record the application.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="application-heading" className="flex flex-col gap-2 rounded border p-4">
      <h2 id="application-heading" className="font-medium">Application</h2>
      {state.kind === "loading" && <p className="text-sm text-gray-600">Loading...</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-red-600">Could not load the application status.</p>}
      {state.kind === "ready" && state.data.application && (
        <div className="flex items-center gap-3 text-sm">
          <p>Applied on {state.data.application.appliedAt} · {STATUS_LABELS[state.data.application.status] ?? state.data.application.status}</p>
          <Link href={`/applications/${state.data.application.id}`} className="underline">Open in tracker</Link>
        </div>
      )}
      {state.kind === "ready" && !state.data.application && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-sm text-gray-600">Record which versions you sent. They are kept with the application.</p>
          <div className="grid grid-cols-3 gap-3">
            <VersionSelect label="Resume version" id="app-resume" options={state.data.documentOptions.resumes} value={resumeId} onChange={setResumeId} />
            <VersionSelect label="Pitch version" id="app-pitch" options={state.data.documentOptions.pitches} value={pitchId} onChange={setPitchId} />
            <VersionSelect label="Cover letter version" id="app-cover-letter" options={state.data.documentOptions.coverLetters} value={coverLetterId} onChange={setCoverLetterId} />
          </div>
          <div className="flex gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Applied on
              <input type="date" value={appliedAt} onChange={(e) => setAppliedAt(e.target.value)} required className="rounded border p-1" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Follow-up date (optional)
              <input type="date" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} className="rounded border p-1" />
            </label>
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="self-start rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {submitting ? "Saving..." : "Mark as applied"}
          </button>
        </form>
      )}
    </section>
  );
}
```
Run the panel test → PASS.

- [ ] **Step 4: Wire into `MatchDetailClient` (test first)**

In `MatchDetailClient.test.tsx`, the existing fetch mock for `/api/matches/...` returns `{ job, match }`. Add a test in which the match is ineligible and `applicationId` is set. It asserts that the Application section and the Documents heading render. Mock every other fetch as `{ ok: true, json: async () => ({ application: null, documentOptions: { resumes: [], pitches: [], coverLetters: [] }, documents: [], optimizations: [], versions: [], research: null }) }`, so each panel gets a harmless empty body:
```tsx
  it("keeps the document panels for an applied job even when it is no longer eligible", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      url.startsWith("/api/matches/")
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({
            job: { id: "j1", title: "DE", companyName: "Acme", locationRaw: null, workMode: "remote", descriptionText: "" },
            match: { eligible: false, ineligibleReason: "You applied to this job at Acme.", overallScore: null, factors: null, explanation: null, userAction: "none" },
            applicationId: "a1",
          }) } as Response)
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ application: null, documentOptions: { resumes: [], pitches: [], coverLetters: [] }, documents: [], optimizations: [], versions: [], research: null }) } as Response)
    ));
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByRole("heading", { name: "Application", exact: true })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Documents", exact: true })).toBeInTheDocument();
  });
```
Run it → FAIL.

In `MatchDetailClient.tsx`:
- Import `ApplicationPanel` from `./ApplicationPanel`.
- Extend `Outcome`'s ready variant with `applicationId: string | null`, and in the fetch handler pass `applicationId: typeof body.applicationId === "string" ? body.applicationId : null`.
- After `const { job, match } = state;` add:
```tsx
  // An applied job becomes ineligible on the next matching run ("already applied"); its documents must stay viewable.
  const showWorkspace = match.eligible || state.applicationId !== null;
```
- Replace each `{match.eligible && <XPanel jobId={jobId} />}` line (Resume, Pitch, CoverLetter, InterviewPrep, DocumentsList) with `{showWorkspace && <XPanel jobId={jobId} />}`, and insert `<ApplicationPanel jobId={jobId} />` (unconditional) immediately before the ResumeOptimizationPanel line.

Run: `pnpm --filter web exec vitest run "src/app/matches"` → PASS (update any existing assertions that counted fetch calls, since the panel adds one fetch).

- [ ] **Step 5: Commit**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
```bash
git add apps/web
git commit -m "feat(web): mark-as-applied panel on the match page"
```

---

### Task 13: `/applications` list page and home nav

**Files:**
- Create: `apps/web/src/app/applications/page.tsx`, `ApplicationsClient.tsx`, `ExternalApplicationForm.tsx`
- Test: `apps/web/src/app/applications/ApplicationsClient.test.tsx`
- Modify: `apps/web/src/app/page.tsx`, `apps/web/src/app/page.test.tsx`

**Interfaces:**
- Consumes: `GET /api/applications` (+ `?due=1`), `POST /api/applications/[id]/events`, `POST /api/applications`, `STATUS_LABELS`, `STATUS_ORDER`.
- Produces: `<ApplicationsClient />`, `<ExternalApplicationForm onCreated />`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/app/applications/ApplicationsClient.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApplicationsClient } from "./ApplicationsClient";

beforeEach(() => vi.unstubAllGlobals());

const app = (over: Record<string, unknown>) => ({
  id: "a1", jobId: "j1", companyName: "Acme", jobTitle: "Data Engineer", status: "applied", appliedAt: "2026-09-01",
  followUpAt: null, external: false, ...over,
});
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: true, status, json: async () => body } as Response);

function mockApi(all: unknown[], due: unknown[]) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return ok({}, 201);
    return ok(url.includes("due=1") ? { applications: due, dueCount: due.length } : { applications: all, dueCount: due.length });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ApplicationsClient", () => {
  it("lists applications with status, an external tag and a link to the detail page", async () => {
    mockApi([app({}), app({ id: "a2", jobId: null, companyName: "Globex", external: true, status: "rejected" })], []);
    render(<ApplicationsClient />);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: /acme/i })).toHaveAttribute("href", "/applications/a1");
    expect(within(table).getByText("External")).toBeInTheDocument();
    expect(within(table).getByText("Rejected")).toBeInTheDocument();
  });

  it("filters by status chip", async () => {
    mockApi([app({}), app({ id: "a2", companyName: "Globex", status: "rejected" })], []);
    render(<ApplicationsClient />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Rejected" }));
    expect(screen.queryByRole("link", { name: /acme/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /globex/i })).toBeInTheDocument();
  });

  it("shows due follow-ups and marks one done", async () => {
    const fetchMock = mockApi([app({ followUpAt: "2026-09-10" })], [app({ followUpAt: "2026-09-10" })]);
    render(<ApplicationsClient />);
    const due = await screen.findByRole("region", { name: /follow-ups due/i });
    fireEvent.click(within(due).getByRole("button", { name: /done/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post?.[0]).toBe("/api/applications/a1/events");
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ type: "follow_up_done", detail: {} });
    });
  });

  it("shows an empty state", async () => {
    mockApi([], []);
    render(<ApplicationsClient />);
    expect(await screen.findByText(/no applications yet/i)).toBeInTheDocument();
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement**

`apps/web/src/app/applications/ExternalApplicationForm.tsx`:
```tsx
"use client";

import { useState, type FormEvent } from "react";

/** For jobs applied to outside the platform (design decision 1). */
export function ExternalApplicationForm({ onCreated }: { onCreated: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [appliedAt, setAppliedAt] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ external: { companyName, jobTitle, jobUrl: jobUrl || null }, appliedAt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "Could not add the application.");
        return;
      }
      setCompanyName("");
      setJobTitle("");
      setJobUrl("");
      onCreated();
    } catch {
      setError("Could not add the application.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="Add external application" className="flex flex-wrap items-end gap-3 rounded border p-4 text-sm">
      <label className="flex flex-col gap-1">Company<input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required maxLength={200} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Job title<input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required maxLength={300} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Posting URL (optional)<input type="url" value={jobUrl} onChange={(e) => setJobUrl(e.target.value)} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Applied on<input type="date" value={appliedAt} onChange={(e) => setAppliedAt(e.target.value)} required className="rounded border p-1" /></label>
      <button type="submit" disabled={submitting} className="rounded bg-black px-3 py-1.5 text-white disabled:opacity-50">Add external application</button>
      {error && <p role="alert" className="w-full text-red-600">{error}</p>}
    </form>
  );
}
```

`apps/web/src/app/applications/ApplicationsClient.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { STATUS_LABELS, STATUS_ORDER } from "../../lib/applications/statusLabels";
import { ExternalApplicationForm } from "./ExternalApplicationForm";

interface Row {
  id: string;
  companyName: string;
  jobTitle: string;
  status: string;
  appliedAt: string;
  followUpAt: string | null;
  external: boolean;
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; all: Row[]; due: Row[] };

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function ApplicationsClient() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [filter, setFilter] = useState<string>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [snoozeTo, setSnoozeTo] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    Promise.all([fetch("/api/applications"), fetch("/api/applications?due=1")])
      .then(async ([all, due]) => {
        if (!all.ok || !due.ok) throw new Error("load failed");
        return [await all.json(), await due.json()];
      })
      .then(([all, due]) => {
        if (!ignore) setState({ kind: "ready", all: all.applications, due: due.applications });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const postFollowUp = async (id: string, body: object) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/applications/${id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed");
      reload();
    } catch {
      setActionError("Could not update the follow-up. Try again.");
    }
  };

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load applications.</p>;

  const rows = filter === "all" ? state.all : state.all.filter((r) => r.status === filter);

  return (
    <div className="flex flex-col gap-6">
      {state.due.length > 0 && (
        <section aria-labelledby="due-heading" className="rounded border border-amber-400 p-4">
          <h2 id="due-heading" className="mb-2 font-medium">Follow-ups due</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {state.due.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/applications/${r.id}`} className="underline">{r.companyName} — {r.jobTitle}</Link>
                <span className="text-gray-600">due {r.followUpAt}</span>
                <button type="button" onClick={() => postFollowUp(r.id, { type: "follow_up_done", detail: {} })} className="rounded border px-2 py-0.5">Done</button>
                <input
                  type="date"
                  aria-label={`Snooze ${r.companyName} until`}
                  value={snoozeTo[r.id] ?? inDays(7)}
                  onChange={(e) => setSnoozeTo((s) => ({ ...s, [r.id]: e.target.value }))}
                  className="rounded border p-0.5"
                />
                <button
                  type="button"
                  onClick={() => postFollowUp(r.id, { type: "follow_up_snoozed", detail: { newFollowUpAt: snoozeTo[r.id] ?? inDays(7) } })}
                  className="rounded border px-2 py-0.5"
                >
                  Snooze
                </button>
              </li>
            ))}
          </ul>
          {actionError && <p role="alert" className="mt-2 text-sm text-red-600">{actionError}</p>}
        </section>
      )}

      <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label="Filter by status">
        {["all", ...STATUS_ORDER].map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
            className={`rounded-full border px-3 py-0.5 ${filter === s ? "bg-black text-white" : ""}`}
          >
            {s === "all" ? "All" : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {state.all.length === 0 ? (
        <p className="text-sm text-gray-600">No applications yet. Mark a match as applied, or add an external application below.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b"><th className="py-1">Company / title</th><th>Status</th><th>Applied</th><th>Follow-up</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="py-1">
                  <Link href={`/applications/${r.id}`} className="underline">{r.companyName} — {r.jobTitle}</Link>
                  {r.external && <span className="ml-2 rounded bg-gray-200 px-1.5 text-xs">External</span>}
                </td>
                <td>{STATUS_LABELS[r.status] ?? r.status}</td>
                <td>{r.appliedAt}</td>
                <td>{r.followUpAt ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ExternalApplicationForm onCreated={reload} />
    </div>
  );
}
```

`apps/web/src/app/applications/page.tsx`:
```tsx
import Link from "next/link";
import { ApplicationsClient } from "./ApplicationsClient";

export default function ApplicationsPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
      <Link href="/" className="text-sm underline">← Home</Link>
      <h1 className="text-2xl font-semibold">Applications</h1>
      <ApplicationsClient />
    </main>
  );
}
```

The "Rejected" filter chip and the "Rejected" status cell share a name; the test's `getByRole("button", { name: "Rejected" })` targets the chip. Run → PASS.

- [ ] **Step 3: Home nav (test first)**

In `apps/web/src/app/page.test.tsx`, change the expected hrefs to `["/profile", "/career-goal", "/sources", "/jobs", "/matches", "/applications"]` and add:
```ts
    expect(screen.getByRole("link", { name: /track what you've applied to/i })).toHaveAttribute("href", "/applications");
```
Run → FAIL. In `apps/web/src/app/page.tsx`, after the Matches link add:
```tsx
        <Link href="/applications" className="underline">
          6. Applications — track what you&apos;ve applied to
        </Link>
```
Run → PASS.

- [ ] **Step 4: Commit**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
```bash
git add apps/web
git commit -m "feat(web): applications list with follow-ups due, status filter and external form"
```

---

### Task 14: `/applications/[id]` detail page

**Files:**
- Create: `apps/web/src/app/applications/[id]/page.tsx`, `ApplicationDetailClient.tsx`, `EventTimeline.tsx`, `LogEventForm.tsx`, `EditApplicationForm.tsx`
- Test: `apps/web/src/app/applications/[id]/ApplicationDetailClient.test.tsx`, `EventTimeline.test.tsx`

**Interfaces:**
- Consumes: `GET/PATCH/DELETE /api/applications/[id]`, `POST .../status`, `POST .../events`, `STATUS_LABELS`, `STATUS_ORDER`, `TERMINAL_STATUS_SET`, `loadEnv().RETENTION_DAYS`.
- Produces: `<ApplicationDetailClient id retentionDays confirm? navigate?>`, `<EventTimeline events>`, `describeEvent(event): string`.

- [ ] **Step 1: Timeline (test first)**

`EventTimeline.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { describeEvent } from "./EventTimeline";

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ id: "e", type, occurredAt: "2026-10-01T00:00:00Z", fromStatus: null, toStatus: null, detail: {}, ...extra });

describe("describeEvent", () => {
  it("describes each event type in plain words", () => {
    expect(describeEvent(ev("status_change", { toStatus: "applied" }))).toBe("Applied");
    expect(describeEvent(ev("status_change", { fromStatus: "applied", toStatus: "rejected" }))).toBe("Status: Applied → Rejected");
    expect(describeEvent(ev("note", { detail: { text: "Called" } }))).toBe("Note: Called");
    expect(describeEvent(ev("recruiter_contact", { detail: { channel: "linkedin", summary: "Intro" } }))).toBe("Recruiter contact (linkedin): Intro");
    expect(describeEvent(ev("interview", { detail: { round: 2, kind: "technical", summary: "" } }))).toBe("Interview round 2 (technical)");
    expect(describeEvent(ev("follow_up_done"))).toBe("Follow-up done");
    expect(describeEvent(ev("follow_up_snoozed", { detail: { newFollowUpAt: "2026-10-08" } }))).toBe("Follow-up snoozed to 2026-10-08");
    expect(describeEvent(ev("documents_purged"))).toBe("Generated documents deleted after the retention period");
  });
});
```

`EventTimeline.tsx`:
```tsx
import { STATUS_LABELS } from "../../../lib/applications/statusLabels";

export interface EventView {
  id: string;
  type: string;
  occurredAt: string;
  fromStatus: string | null;
  toStatus: string | null;
  detail: unknown;
}

const label = (s: string | null) => (s ? STATUS_LABELS[s] ?? s : "");
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function describeEvent(e: EventView): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "status_change":
      return e.fromStatus ? `Status: ${label(e.fromStatus)} → ${label(e.toStatus)}` : label(e.toStatus);
    case "note":
      return `Note: ${str(d.text)}`;
    case "recruiter_contact":
      return `Recruiter contact (${str(d.channel)})${str(d.summary) ? `: ${str(d.summary)}` : ""}`;
    case "interview": {
      const round = typeof d.round === "number" ? ` round ${d.round}` : "";
      const when = str(d.scheduledFor) ? ` scheduled for ${new Date(str(d.scheduledFor)).toLocaleString()}` : "";
      return `Interview${round} (${str(d.kind)})${when}${str(d.summary) ? `: ${str(d.summary)}` : ""}`;
    }
    case "follow_up_done":
      return "Follow-up done";
    case "follow_up_snoozed":
      return `Follow-up snoozed to ${str(d.newFollowUpAt)}`;
    case "documents_purged":
      return "Generated documents deleted after the retention period";
    default:
      return e.type;
  }
}

export function EventTimeline({ events }: { events: EventView[] }) {
  return (
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading" className="mb-2 font-medium">Timeline</h2>
      <ol className="flex flex-col gap-1 text-sm">
        {events.map((e) => (
          <li key={e.id}>
            <span className="text-gray-600">{new Date(e.occurredAt).toLocaleDateString()}</span> — {describeEvent(e)}
          </li>
        ))}
      </ol>
    </section>
  );
}
```
Run: `pnpm --filter web exec vitest run "src/app/applications/\[id\]/EventTimeline.test.tsx"` → PASS.

- [ ] **Step 2: Forms**

`LogEventForm.tsx`:
```tsx
"use client";

import { useState, type FormEvent } from "react";

type Kind = "note" | "recruiter_contact" | "interview";

/** Posts one user event; `onLogged` reloads the page data. */
export function LogEventForm({ applicationId, onLogged }: { applicationId: string; onLogged: () => void }) {
  const [kind, setKind] = useState<Kind>("note");
  const [text, setText] = useState("");
  const [channel, setChannel] = useState("email");
  const [interviewKind, setInterviewKind] = useState("phone_screen");
  const [round, setRound] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const body =
      kind === "note"
        ? { type: "note", detail: { text } }
        : kind === "recruiter_contact"
          ? { type: "recruiter_contact", detail: { channel, summary: text } }
          : {
              type: "interview",
              detail: {
                kind: interviewKind,
                summary: text,
                ...(round ? { round: Number(round) } : {}),
                ...(scheduledFor ? { scheduledFor: new Date(scheduledFor).toISOString() } : {}),
              },
            };
    try {
      const res = await fetch(`/api/applications/${applicationId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(typeof b.error === "string" ? b.error : "Could not log the event.");
        return;
      }
      setText("");
      onLogged();
    } catch {
      setError("Could not log the event.");
    }
  };

  return (
    <form onSubmit={submit} aria-label="Log event" className="flex flex-col gap-2 rounded border p-4 text-sm">
      <h2 className="font-medium">Log an event</h2>
      <label className="flex flex-col gap-1">
        Event type
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="rounded border p-1">
          <option value="note">Note</option>
          <option value="recruiter_contact">Recruiter contact</option>
          <option value="interview">Interview</option>
        </select>
      </label>
      {kind === "recruiter_contact" && (
        <label className="flex flex-col gap-1">
          Channel
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded border p-1">
            <option value="email">Email</option><option value="phone">Phone</option><option value="linkedin">LinkedIn</option><option value="other">Other</option>
          </select>
        </label>
      )}
      {kind === "interview" && (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1">
            Interview kind
            <select value={interviewKind} onChange={(e) => setInterviewKind(e.target.value)} className="rounded border p-1">
              <option value="phone_screen">Phone screen</option><option value="technical">Technical</option><option value="behavioral">Behavioral</option>
              <option value="onsite">Onsite</option><option value="panel">Panel</option><option value="other">Other</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">Round<input type="number" min={1} max={20} value={round} onChange={(e) => setRound(e.target.value)} className="w-16 rounded border p-1" /></label>
          <label className="flex flex-col gap-1">Scheduled for<input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} className="rounded border p-1" /></label>
        </div>
      )}
      <label className="flex flex-col gap-1">
        {kind === "note" ? "Note" : "Summary (optional)"}
        <textarea value={text} onChange={(e) => setText(e.target.value)} required={kind === "note"} maxLength={kind === "note" ? 5000 : 2000} className="rounded border p-1" />
      </label>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <button type="submit" className="self-start rounded bg-black px-3 py-1.5 text-white">Log event</button>
    </form>
  );
}
```

`EditApplicationForm.tsx`:
```tsx
"use client";

import { useState, type FormEvent } from "react";

export interface EditableFields {
  recruiterName: string | null;
  recruiterContact: string | null;
  salaryNotes: string | null;
  notes: string | null;
  followUpAt: string | null;
}

export function EditApplicationForm({ applicationId, initial, onSaved }: { applicationId: string; initial: EditableFields; onSaved: () => void }) {
  const [fields, setFields] = useState({
    recruiterName: initial.recruiterName ?? "",
    recruiterContact: initial.recruiterContact ?? "",
    salaryNotes: initial.salaryNotes ?? "",
    notes: initial.notes ?? "",
    followUpAt: initial.followUpAt ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recruiterName: fields.recruiterName || null,
          recruiterContact: fields.recruiterContact || null,
          salaryNotes: fields.salaryNotes || null,
          notes: fields.notes || null,
          followUpAt: fields.followUpAt || null,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(typeof b.error === "string" ? b.error : "Could not save.");
        return;
      }
      onSaved();
    } catch {
      setError("Could not save.");
    }
  };

  return (
    <form onSubmit={submit} aria-label="Edit application" className="grid grid-cols-2 gap-2 rounded border p-4 text-sm">
      <h2 className="col-span-2 font-medium">Details</h2>
      <label className="flex flex-col gap-1">Recruiter name<input value={fields.recruiterName} onChange={set("recruiterName")} maxLength={200} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Recruiter contact<input value={fields.recruiterContact} onChange={set("recruiterContact")} maxLength={300} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Salary notes<input value={fields.salaryNotes} onChange={set("salaryNotes")} maxLength={500} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Follow-up date<input type="date" value={fields.followUpAt} onChange={set("followUpAt")} className="rounded border p-1" /></label>
      <label className="col-span-2 flex flex-col gap-1">Notes<textarea value={fields.notes} onChange={set("notes")} maxLength={5000} className="rounded border p-1" /></label>
      {error && <p role="alert" className="col-span-2 text-red-600">{error}</p>}
      <button type="submit" className="self-start rounded bg-black px-3 py-1.5 text-white">Save details</button>
    </form>
  );
}
```

- [ ] **Step 3: Write the failing detail-client test**

`ApplicationDetailClient.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApplicationDetailClient } from "./ApplicationDetailClient";

beforeEach(() => vi.unstubAllGlobals());

const application = {
  id: "a1", jobId: "j1", companyName: "Acme", jobTitle: "Data Engineer", jobUrl: "https://jobs.example/1", status: "interviewing",
  appliedAt: "2026-09-01", followUpAt: null, recruiterName: null, recruiterContact: null, salaryNotes: null, notes: null,
  terminalAt: null, retentionPurgedAt: null, external: false,
  snapshotSummary: { matchOverall: 78, atsOverall: 82, documents: { resume: 3, pitch: 2, coverLetter: null } },
};
const events = [{ id: "e1", type: "status_change", occurredAt: "2026-09-01T00:00:00Z", fromStatus: null, toStatus: "applied", detail: {} }];

function mockApi(app = application) {
  const fn = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve({ ok: true, status: init?.method === "DELETE" ? 204 : 200, json: async () => ({ application: app, events }) } as Response)
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ApplicationDetailClient", () => {
  it("shows the header, snapshot line, sent documents and timeline", async () => {
    mockApi();
    render(<ApplicationDetailClient id="a1" retentionDays={30} />);
    expect(await screen.findByRole("heading", { name: /acme — data engineer/i })).toBeInTheDocument();
    expect(screen.getByText(/match 78 · ats 82 at time of applying/i)).toBeInTheDocument();
    expect(screen.getByText(/resume v3/i)).toBeInTheDocument();
    expect(screen.getByText(/pitch v2/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open job workspace/i })).toHaveAttribute("href", "/matches/j1");
    // "Applied" is also a status <option>, so scope the timeline assertion to its region.
    expect(within(screen.getByRole("region", { name: /timeline/i })).getByText(/applied/i)).toBeInTheDocument();
  });

  it("asks for confirmation before a terminal status and does nothing if declined", async () => {
    const fetchMock = mockApi();
    const confirm = vi.fn(() => false);
    render(<ApplicationDetailClient id="a1" retentionDays={30} confirm={confirm} />);
    fireEvent.change(await screen.findByLabelText(/new status/i), { target: { value: "rejected" } });
    fireEvent.click(screen.getByRole("button", { name: /update status/i }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/deleted 30 days/i));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/status"))).toBe(false);
  });

  it("posts a confirmed status change", async () => {
    const fetchMock = mockApi();
    render(<ApplicationDetailClient id="a1" retentionDays={30} confirm={() => true} />);
    fireEvent.change(await screen.findByLabelText(/new status/i), { target: { value: "rejected" } });
    fireEvent.click(screen.getByRole("button", { name: /update status/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/status"));
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({ toStatus: "rejected" });
    });
  });

  it("says documents were deleted once purged", async () => {
    mockApi({ ...application, status: "rejected", retentionPurgedAt: "2026-11-01T00:00:00Z" });
    render(<ApplicationDetailClient id="a1" retentionDays={30} />);
    expect(await screen.findByText(/documents deleted after the retention period/i)).toBeInTheDocument();
  });

  it("deletes after confirmation and navigates back to the list", async () => {
    mockApi();
    const navigate = vi.fn();
    render(<ApplicationDetailClient id="a1" retentionDays={30} confirm={() => true} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: /delete application/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/applications"));
  });
});
```
Run → FAIL.

- [ ] **Step 4: Implement `ApplicationDetailClient.tsx` and `page.tsx`**

`ApplicationDetailClient.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { STATUS_LABELS, STATUS_ORDER, TERMINAL_STATUS_SET } from "../../../lib/applications/statusLabels";
import { EventTimeline, type EventView } from "./EventTimeline";
import { LogEventForm } from "./LogEventForm";
import { EditApplicationForm } from "./EditApplicationForm";

interface ApplicationView {
  id: string;
  jobId: string | null;
  companyName: string;
  jobTitle: string;
  jobUrl: string | null;
  status: string;
  appliedAt: string;
  followUpAt: string | null;
  recruiterName: string | null;
  recruiterContact: string | null;
  salaryNotes: string | null;
  notes: string | null;
  terminalAt: string | null;
  retentionPurgedAt: string | null;
  external: boolean;
  snapshotSummary: { matchOverall: number | null; atsOverall: number | null; documents: { resume: number | null; pitch: number | null; coverLetter: number | null } };
}
type State = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ready"; application: ApplicationView; events: EventView[] };

export function ApplicationDetailClient({
  id,
  retentionDays,
  confirm = (message: string) => window.confirm(message),
  navigate = (url: string) => window.location.assign(url),
}: {
  id: string;
  retentionDays: number;
  confirm?: (message: string) => boolean;
  navigate?: (url: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [nextStatus, setNextStatus] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    fetch(`/api/applications/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (res.status === 404) return { kind: "missing" } as State;
        if (!res.ok) throw new Error("load failed");
        const body = await res.json();
        return { kind: "ready", application: body.application, events: body.events } as State;
      })
      .then((next) => {
        if (!ignore) setState(next);
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [id, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "missing") return <p>Application not found. <Link href="/applications" className="underline">All applications</Link></p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load this application.</p>;

  const { application: a, events } = state;
  const summary = a.snapshotSummary;
  const docs = [
    summary.documents.resume !== null && `Resume v${summary.documents.resume}`,
    summary.documents.pitch !== null && `Pitch v${summary.documents.pitch}`,
    summary.documents.coverLetter !== null && `Cover letter v${summary.documents.coverLetter}`,
  ].filter(Boolean) as string[];

  const updateStatus = async () => {
    if (!nextStatus || nextStatus === a.status) return;
    const enteringTerminal = TERMINAL_STATUS_SET.has(nextStatus) && !TERMINAL_STATUS_SET.has(a.status);
    if (enteringTerminal && a.jobId && retentionDays > 0 &&
        !confirm(`Documents generated for this job will be deleted ${retentionDays} days after this status. Continue?`)) {
      return;
    }
    setActionError(null);
    try {
      const res = await fetch(`/api/applications/${a.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toStatus: nextStatus }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setActionError(typeof b.error === "string" ? b.error : "Could not update the status.");
        return;
      }
      setNextStatus("");
      reload();
    } catch {
      setActionError("Could not update the status.");
    }
  };

  const remove = async () => {
    if (!confirm("Delete this application and its timeline? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/applications/${a.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("failed");
      navigate("/applications");
    } catch {
      setActionError("Could not delete the application.");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Link href="/applications" className="text-sm underline">← All applications</Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{a.companyName} — {a.jobTitle}</h1>
        <p className="text-sm text-gray-600">
          {STATUS_LABELS[a.status] ?? a.status} · applied {a.appliedAt}
          {a.external && " · External"}
          {a.jobUrl && <> · <a href={a.jobUrl} target="_blank" rel="noopener noreferrer" className="underline">Posting</a></>}
        </p>
        {(summary.matchOverall !== null || summary.atsOverall !== null) && (
          <p className="text-sm text-gray-600">
            Match {summary.matchOverall ?? "—"} · ATS {summary.atsOverall ?? "—"} at time of applying
          </p>
        )}
      </header>

      <section aria-labelledby="status-heading" className="flex flex-wrap items-end gap-2 text-sm">
        <h2 id="status-heading" className="w-full font-medium">Status</h2>
        <label className="flex flex-col gap-1">
          New status
          <select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} className="rounded border p-1">
            <option value="">Choose...</option>
            {STATUS_ORDER.filter((s) => s !== a.status).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <button type="button" onClick={updateStatus} className="rounded bg-black px-3 py-1.5 text-white">Update status</button>
        {actionError && <p role="alert" className="w-full text-red-600">{actionError}</p>}
      </section>

      {!a.external && (
        <section aria-labelledby="sent-heading" className="text-sm">
          <h2 id="sent-heading" className="mb-1 font-medium">Documents sent</h2>
          {a.retentionPurgedAt ? (
            <p>Documents deleted after the retention period.</p>
          ) : (
            <>
              <p>{docs.length > 0 ? docs.join(" · ") : "None recorded"}</p>
              {a.jobId && <Link href={`/matches/${a.jobId}`} className="underline">Open job workspace</Link>}
            </>
          )}
        </section>
      )}

      <EditApplicationForm key={reloadKey} applicationId={a.id} initial={a} onSaved={reload} />
      <EventTimeline events={events} />
      <LogEventForm applicationId={a.id} onLogged={reload} />

      <button type="button" onClick={remove} className="self-start text-sm text-red-700 underline">Delete application</button>
    </div>
  );
}
```

`apps/web/src/app/applications/[id]/page.tsx`:
```tsx
import { loadEnv } from "@ai-career/config";
import { ApplicationDetailClient } from "./ApplicationDetailClient";

// Next 16: dynamic route params arrive as a Promise.
export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <ApplicationDetailClient id={id} retentionDays={loadEnv().RETENTION_DAYS} />
    </main>
  );
}
```

Run: `pnpm --filter web exec vitest run src/app/applications` → PASS.

- [ ] **Step 5: Full web checks and commit**

Run: `pnpm --filter web test && pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build`
Expected: all green; the build lists `/applications` and `/applications/[id]`.
```bash
git add apps/web
git commit -m "feat(web): application detail page with status, timeline, events and edits"
```

---

### Task 15: Documentation

**Files:**
- Modify: `DECISIONS.md`, `FLOW.md`, `docs/architecture.md`, `README.md`, `.env.example`, `docs/superpowers/specs/2026-09-30-phase-9-application-tracker-design.md`

- [ ] **Step 1: DECISIONS.md**

Append a `## 2026-09-30 — Phase 9: Application Tracker` section with entries D112–D121, each in the file's existing format (**Decision / Alternatives considered / Why / What it affects**):
- **D112** Phase 8 deferred; applications are user-recorded. Phase 8's `automation_sessions` can later link to `applications.id`.
- **D113** External applications allowed (`job_id` nullable, `ON DELETE SET NULL`, company/title always copied).
- **D114** Permissive lifecycle + append-only `application_events`; status stored on the row for filtering.
- **D115** `terminal_at` starts at *now*, not the backdated `occurredAt`; terminal→terminal keeps the clock.
- **D116** Feature snapshot written once at creation; link edits never rewrite it. Known gap: correcting a linked document after applying leaves the snapshot's `documents` showing the original choice.
- **D117** No `application_outcomes` table (spec §19 deviation); outcome = terminal status + event.
- **D118** "Already applied" is an eligibility rule computed per run; match detail shows panels when an application exists; regenerating documents for an applied job is refused. This supersedes the Phase 5 "no applications table" known gap.
- **D119** Retention: rows first in a per-application transaction with `FOR UPDATE SKIP LOCKED`, objects after commit, orphan sweep with a 24h guard; replaces the spec's advisory-lock/objects-first wording. This supersedes the Phase 7b known gap (D87 area) on orphaned objects.
- **D120** Follow-ups in-app only; no notifications table.
- **D121** Client-side `statusLabels` duplicates the status list to keep DB code out of client bundles, guarded by a lockstep test.

- [ ] **Step 2: FLOW.md**

Add `## 12. Phase 9 — Application Tracker` with sub-sections:
- **12a** Mark as applied: `ApplicationPanel` → `GET /api/applications/for-job/[jobId]` → `getApplicationForJob` + `listDocumentOptions`; submit → `POST /api/applications` → `CreateApplicationBodySchema` → `createApplication` → `loadLinkedDocuments` → `buildFeatureSnapshot` → insert application + `status_change` event (one tx).
- **12b** Status/events/edits: `ApplicationDetailClient` → `POST .../status` → `changeStatus` → `planStatusChange`; `POST .../events` → `addEvent`; `PATCH` → `updateApplication`.
- **12c** Matching: `runMatching` loads applied job ids → `evaluateEligibility({ alreadyApplied })`.
- **12d** Retention: `services/maintenance-worker/src/main.ts` → `scheduleRetention` → worker → `runRetentionSweep` → `planRetention` → `purgeOne` (tx) → `storage.removeObject` → orphan sweep; plus `pnpm retention:run` → `runOnce.ts`.

Mark in each which files are new in Phase 9.

- [ ] **Step 3: architecture.md, README, .env.example, spec**

- `docs/architecture.md`: update the status line to "Phases 0–7c and 9 are implemented; Phase 8 (browser automation) is deferred". Add §17 "Application Tracker (Phase 9)" (tables, package, routes, worker, retention, known gaps: snapshot not updated on link edits, no Dockerfile for maintenance-worker, applied jobs cannot regenerate documents). In §8 add the two tables. In §9 retention, note it is implemented and point to §17. Remove "(Phase 9 retention)" known-gap wording in §15, replacing it with "swept by Phase 9 retention".
- `README.md`: add a "Phase 9 (Application Tracker) complete" paragraph, plus how to run `pnpm --filter @ai-career/maintenance-worker start` and `pnpm retention:run`.
- `.env.example`: add
```
# Phase 9: days after an application's terminal status before its generated documents are deleted. 0 disables.
# RETENTION_DAYS=30
```
- Spec: add `## 11. Post-implementation notes` listing deviations found during implementation (at minimum D115, D118's panel/regeneration behaviour, D119).

- [ ] **Step 4: Commit**

```bash
git add DECISIONS.md FLOW.md docs README.md .env.example
git commit -m "docs: Phase 9 application tracker decisions, flow and architecture"
```

---

### Task 16: Whole-repo verification and real-browser E2E

**Files:** none in the repo (scripts live in the session scratchpad).

- [ ] **Step 1: CI-order checks on a clean tree**

Run: `pnpm lint && pnpm build && pnpm typecheck && pnpm test`
Expected: all green. Record the test counts. Any failure is fixed in the owning task's files and committed as `fix(...)`.

- [ ] **Step 2: Real-browser E2E (per the project's E2E recipe)**

1. Migrate the dev DB (`pnpm --filter @ai-career/db db:migrate`). Seed or reuse a confirmed goal, a job with a match, and a generated resume and pitch. Use the fake Anthropic server (`ANTHROPIC_BASE_URL=http://localhost:4010`) if anything needs generating.
2. `pnpm --filter web build && ANTHROPIC_BASE_URL=http://localhost:4010 pnpm --filter web start`.
3. Drive it with playwright-core and system Chrome (`executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`). Use `exact: true` on heading queries.
   - `/matches/<jobId>` → Application panel shows the newest versions preselected → Mark as applied → "Applied on …" + "Open in tracker".
   - `/applications` → the row is listed; add an external application → it appears tagged External.
   - `/applications/<id>` → change the status to Interviewing → log an interview (round 1, technical) → the timeline shows both; save recruiter name; set the status to Rejected → the confirm dialog appears (accept it).
   - In SQL, backdate: `UPDATE applications SET terminal_at = now() - interval '31 days' WHERE id = '<id>'`.
   - `pnpm retention:run` → prints `purgedApplications: 1`; the detail page shows "Documents deleted after the retention period"; the timeline shows the purge event; `SELECT count(*) FROM generated_documents WHERE job_id = '<jobId>'` is 0, and the MinIO objects are gone (`mc ls` or the storage client).
   - Run "Find Matches"; the job now shows "You applied to this job at …" and still shows the document panels.
4. Save screenshots to the scratchpad. Record the run in DECISIONS.md as **D122**, in the style of D111: what was exercised, what wasn't, where the artifacts are. Commit `docs(decisions): Phase 9 real-browser E2E (D122)`.

- [ ] **Step 3: Final review hand-off**

Request the whole-branch code review (superpowers:requesting-code-review), then superpowers:finishing-a-development-branch.
