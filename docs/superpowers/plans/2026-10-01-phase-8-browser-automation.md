# Phase 8 — Browser Automation (Guarded Autofill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a supported Greenhouse/Lever application form in a headed Chrome window, fill only the fields that can be identified with confidence, attach the generated resume, audit every field, hand the window to the user (who clicks Submit), detect the confirmation page, and offer a one-click "Record as applied".

**Architecture:** A pure package `packages/browser` (adapters, an in-page snapshot script, field classification, values, fill plan, submission detection, and thin DB operations under `withUserContext`; **no Playwright import**). A host-only BullMQ consumer `services/browser-worker` (`playwright-core` + system Chrome) whose guarded action layer can only `fill`, `selectOption`, `check` and `setInputFiles`. Next.js routes under `/api/automation-sessions` validate, create the row, and enqueue; `AutofillPanel` polls the session.

**Tech Stack:** TypeScript, Drizzle ORM 0.36 + drizzle-kit 0.28 (Postgres 16), Zod 3.24, BullMQ 5, playwright-core 1.63 (system Chrome via `channel: "chrome"`), jsdom 25 (tests only), MinIO JS client 8, Next.js 16 (App Router), React 19, Vitest 2, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-01-phase-8-browser-automation-design.md` (§11 lists the plan-time refinements; Task 1 Step 0 adds it).

## Global Constraints

- Every user-scoped table has `user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid`, RLS enabled, and policy `user_isolation USING (user_id = current_setting('app.current_user_id')::uuid)`.
- All app-runtime DB access goes through `withUserContext(db, userId, fn)` from `@ai-career/db`. Admin SQL is only for tests.
- Session statuses: `queued, launching, filling, awaiting_user, submission_detected, abandoned, needs_manual, failed`. Active: the first four. Terminal: the last four. `ended_at IS NOT NULL` exactly when terminal.
- Portals: `greenhouse` (adapter `greenhouse-v1`), `lever` (adapter `lever-v1`). Nothing else is supported.
- Form URLs are built, never scraped: Greenhouse `https://job-boards.greenhouse.io/{slug}/jobs/{externalId}`, Lever `https://jobs.lever.co/{slug}/{externalId}/apply`. `slug` and `externalId` must match `^[A-Za-z0-9._-]+$`.
- `packages/browser` must not import `playwright-core`, `bullmq` or `ioredis`.
- **Stop before submit:** `services/browser-worker/src` (non-test files) must not contain `.click(`, `.dblclick(`, `.tap(`, `.press(`, `.submit(`, `keyboard`, `requestSubmit`, `dispatchEvent`. The only page-mutating calls are `fill`, `selectOption`, `check`, `setInputFiles`, each in `actions.ts` behind a tag/type guard. `check` is only allowed on `input[type=radio|checkbox]`.
- `field_audit` never contains a field value. Only keys, labels (≤200 chars), canonical names, actions, reasons, value *sources* (e.g. `profile.email`) and `verified`.
- Logs carry session ids, statuses, error codes and counts only. Never field values, labels, profile data or full URLs.
- Never-filled categories: `github`, `website`, `work_authorization`, `eeo`, unrecognized. They are `flagged` when required and `skipped` when optional; `eeo` uses reason `intentionally_not_filled`, the rest `not_auto_filled` / `unrecognized`.
- Combobox widgets (`role="combobox"` or `aria-autocomplete`) are never filled: choosing an option needs a click.
- Functions passed to Playwright's `evaluate` are inline anonymous arrows with no inner named functions/consts (tsx's esbuild `keepNames` injects `__name`, which does not exist in the page). The snapshot extractor is a plain-JS **string** (`EXTRACT_SNAPSHOT_SOURCE`).
- Env: `BROWSER_EXECUTABLE_PATH` (optional), `BROWSER_HEADLESS` (`"true"|"false"`, default `false`), `BROWSER_SESSION_TIMEOUT_MIN` (int 1–240, default 30).
- HTTP mapping: 400 validation; 404 unknown/non-UUID job or session; 409 `profile_missing`, `session_active`, `not_cancellable`, `session_not_linkable`, `already_applied`; 422 `unsupported`; 503 enqueue failure.
- Test user ids reserved for this phase (verified unused repo-wide on 2026-10-01): `…0008a1`–`…0008a9`, `…0008b1`–`…0008b5` (full form `00000000-0000-0000-0000-0000000008a1`). Before using one, re-run `grep -rn "<id>" --include=*.ts --include=*.tsx --exclude-dir=node_modules .` and confirm only your file uses it.
- New DECISIONS entries start at **D127**; before writing one, check `grep -n "^### D1[2-9][0-9]" DECISIONS.md | tail -1` for the next free number.
- Do not commit `.env`. Commit after each task with the message in its last step, ending with the session's `Co-Authored-By` / `Claude-Session` trailer lines.
- Local services must be up for tests: `docker compose -f infra/docker-compose.yml up -d` (postgres, redis, minio). If Docker is down: `open -a Docker` first. A fresh worktree needs `pnpm install` and one `pnpm --filter web build` before `tsc` works on `apps/web`.

---

## File Structure

**DB (`packages/db`)**
- Create `src/schema/automationSessions.ts`: `automationPortalEnum`, `automationStatusEnum`, `automationSessions`.
- Modify `src/schema/index.ts`: export it.
- Create `migrations/0026_<generated>.sql` (drizzle-kit) and `migrations/0027_automation_sessions_rls.sql` (custom: RLS + partial unique indexes).
- Modify `package.json`: `db:generate:custom:automation-sessions-rls`.
- Create `src/automationSessionsTable.rls.test.ts`.

**Config (`packages/config`)**: modify `src/env.ts` (+ `env.test.ts`) for the three `BROWSER_*` vars.

**Domain (`packages/browser`, new; no Playwright)**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`.
- `fixtures/greenhouse-v1-form.html`, `fixtures/lever-v1-form.html`: sanitized real forms (committed with this plan).
- `src/types.ts`: statuses, portals, snapshot/audit/action/value types.
- `src/queue.ts`: queue name, job name, job data, job id, job options.
- `src/errors.ts`: `AutomationError`.
- `src/adapters/types.ts`, `greenhouse.ts`, `lever.ts`, `index.ts`: the adapter contract and both adapters.
- `src/adapters/resolveAutofillTarget.ts`: pure posting → `{adapter, formUrl}` choice.
- `src/snapshot/extractSnapshotSource.ts`: `EXTRACT_SNAPSHOT_SOURCE` (plain JS string).
- `src/values/buildAutofillValues.ts`.
- `src/plan/classifyField.ts`, `src/plan/buildFillPlan.ts`.
- `src/detect/detectSubmission.ts`.
- `src/sessions/createSession.ts`, `readSessions.ts`, `transitions.ts`, `loadAutofillContext.ts`, `support.ts`.
- `src/testing/db.ts`, `src/testing/snapshotFromHtml.ts`, `src/testing/index.ts`.
- `src/index.ts`.

**Worker (`services/browser-worker`, new; host-only)**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`.
- `src/actions.ts` (guarded action layer), `src/snapshot.ts`, `src/browser.ts` (launch + released windows), `src/attachments.ts`, `src/runSession.ts`, `src/worker.ts`, `src/main.ts`.
- Tests: `src/actions.test.ts`, `src/noClick.test.ts`, `src/runSession.test.ts`, `src/testing/fixtureServer.ts`.

**Applications (`packages/applications`)**: modify `src/bodies.ts`, `src/errors.ts`, `src/createApplication.ts` (+ tests) for `automationSessionId`.

**Web (`apps/web`)**
- Modify `package.json`: depend on `@ai-career/browser`.
- Create `src/lib/browser-automation/enqueue.ts`, `serializeSession.ts` (+ test), `errorResponse.ts`.
- Create routes `src/app/api/automation-sessions/route.ts`, `[id]/route.ts`, `[id]/cancel/route.ts` (+ tests).
- Modify `src/lib/applications/errorResponse.ts`.
- Modify `src/test/jobsDb.ts`: `insertAutomationSession`; `wipeJobData` unchanged (sessions cascade from jobs).
- Create `src/app/matches/[jobId]/AutofillPanel.tsx` (+ test). Modify `MatchDetailClient.tsx`, `ApplicationPanel.tsx` (+ tests).

**Docs**: `DECISIONS.md` (D127+; D4 marked superseded), `FLOW.md`, `docs/architecture.md` §6, `README.md`, `.env.example`, `LEGAL.md`, spec §11 / status.

---

### Task 1: Database table, migrations and RLS

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-phase-8-browser-automation-design.md` (Step 0 only)
- Create: `packages/db/src/schema/automationSessions.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/db/package.json`
- Create: `packages/db/migrations/0026_*.sql` (generated), `packages/db/migrations/0027_automation_sessions_rls.sql` (custom)
- Test: `packages/db/src/automationSessionsTable.rls.test.ts`

**Interfaces:**
- Produces: `schema.automationSessions`, `schema.automationPortalEnum`, `schema.automationStatusEnum`. Column property names: `id, userId, jobId, applicationId, portal, adapterVersion, formUrl, status, resumeDocumentId, coverLetterDocumentId, fieldAudit (unknown[]), stoppedBeforeSubmit, cancelRequestedAt, errorCode, submissionDetectedAt, startedAt, endedAt, createdAt, updatedAt`.

- [ ] **Step 0: Add the plan-time refinements to the spec**

Append to `docs/superpowers/specs/2026-10-01-phase-8-browser-automation-design.md`:

```markdown
## 11. Plan-time refinements (2026-10-01)

Found while writing the implementation plan, mostly from inspecting the live Greenhouse and Lever forms:

1. **Greenhouse yes/no questions are combobox widgets** (react-select, `role="combobox"`), not native selects; so are country and the EEO fields. Combobox widgets are never filled (an option needs a click), so on Greenhouse the sponsorship question is always flagged. Lever uses native radios/selects, so sponsorship is filled there.
2. **Lever's location input is an autocomplete widget** (free text plus a hidden `selectedLocation`): the `lever-v1` adapter flags it (`autocomplete_widget`). Lever has no cover-letter file input (only a free-text "Additional information" box), so no cover letter is attached on Lever.
3. **Health check = required canonicals:** the form root exists and each of the adapter's required canonical fields (Greenhouse: first name, last name, email, resume; Lever: full name, email, resume) is matched by exactly one field.
4. **Never-filled fields use one rule:** flagged when required, skipped when optional (EEO keeps reason `intentionally_not_filled`).
5. **The startup sweep only touches `launching`/`filling`/`awaiting_user`.** A `queued` session waits for the worker; the panel shows a "is the worker running?" hint after 10 s, and Cancel moves it to `abandoned`.
6. **Released windows.** On `needs_manual` and `submission_detected` the worker leaves the window open, returns the job (so the next session is not blocked behind an open window), and closes that window at the session timeout or on worker shutdown.
7. **Detection polls** every second (URL + first 5,000 chars of body text across the context's pages) instead of event listeners, and the session timeout, cancel flag and closed-window checks run in the same loop.
8. **"Record as applied" is one click:** `POST /api/applications {jobId, automationSessionId}` links the documents that were actually attached (generated_documents → resume optimization / cover letter); there is no version picker on this path.
9. **The snapshot extractor is a plain-JS string** evaluated in the page and unit-tested in jsdom against the sanitized real forms, because tsx's `keepNames` breaks functions passed to `page.evaluate`.
10. **Attachments live as long as the window.** Chrome reads an `<input type=file>` when the form is submitted, so the downloaded PDFs share a temp root with the throwaway browser profile and are deleted together when the window closes.
11. **E2E is live, never submitting.** The real app + worker are run headed against one live Greenhouse and one live Lever posting, stopping before Submit (window closed → `abandoned` → "Record as applied"). Confirmation detection is covered by the real-Chrome fixture integration tests, since triggering it live would need a real submission.
```

- [ ] **Step 1: Write the schema file**

`packages/db/src/schema/automationSessions.ts`:
```ts
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, boolean, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { applications } from "./applications";
import { generatedDocuments } from "./generatedDocuments";

export const automationPortalEnum = pgEnum("automation_portal", ["greenhouse", "lever"]);
export const automationStatusEnum = pgEnum("automation_status", [
  "queued", "launching", "filling", "awaiting_user", "submission_detected", "abandoned", "needs_manual", "failed",
]);

/**
 * Phase 8 design §3. One row per autofill attempt. field_audit holds FieldAuditEntry[] (packages/browser
 * types.ts) and never a field value (CLAUDE.md §9). The partial unique indexes -- at most one active
 * session per user, and one session per linked application -- live in the custom migration 0027.
 * stopped_before_submit is the spec §19 flag: the worker has no submit path, so it is never set false.
 */
export const automationSessions = pgTable(
  "automation_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
    portal: automationPortalEnum("portal").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    formUrl: text("form_url").notNull(),
    status: automationStatusEnum("status").notNull().default("queued"),
    resumeDocumentId: uuid("resume_document_id").references(() => generatedDocuments.id, { onDelete: "set null" }),
    coverLetterDocumentId: uuid("cover_letter_document_id").references(() => generatedDocuments.id, { onDelete: "set null" }),
    fieldAudit: jsonb("field_audit").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    stoppedBeforeSubmit: boolean("stopped_before_submit").notNull().default(true),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    errorCode: text("error_code"),
    submissionDetectedAt: timestamp("submission_detected_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobCreatedIdx: index("automation_sessions_user_job_created_idx").on(t.userId, t.jobId, t.createdAt),
    auditIsArray: check("automation_sessions_field_audit_array", sql`jsonb_typeof(${t.fieldAudit}) = 'array'`),
    // status::text, not a bare enum literal: same one-transaction migrator caveat as applications.
    endedAtMatchesStatus: check(
      "automation_sessions_ended_at_matches_status",
      sql`(${t.status}::text IN ('submission_detected', 'abandoned', 'needs_manual', 'failed')) = (${t.endedAt} IS NOT NULL)`
    ),
  })
);
```

Add to the end of `packages/db/src/schema/index.ts`:
```ts
export * from "./automationSessions";
```

- [ ] **Step 2: Generate the table migration**

Run: `pnpm --filter @ai-career/db db:generate`
Expected: a new `packages/db/migrations/0026_<random_name>.sql` creating both enums, the table, FKs, the index and both CHECKs. Open it and confirm it contains nothing else (no changes to existing tables).

- [ ] **Step 3: Generate and write the custom RLS migration**

Add to `packages/db/package.json` scripts (after `db:generate:custom:applications-rls`):
```json
    "db:generate:custom:automation-sessions-rls": "dotenv -e ../../.env -- drizzle-kit generate --custom --name=automation_sessions_rls",
```
Run: `pnpm --filter @ai-career/db db:generate:custom:automation-sessions-rls`
Expected: an empty `packages/db/migrations/0027_automation_sessions_rls.sql`. Replace its contents with:
```sql
-- Custom SQL migration: RLS + partial unique indexes for the Phase 8 table. Follows 0025.

ALTER TABLE automation_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON automation_sessions
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- One automated browser window per user at a time (design §3).
CREATE UNIQUE INDEX automation_sessions_one_active_per_user ON automation_sessions (user_id)
  WHERE status::text IN ('queued', 'launching', 'filling', 'awaiting_user');

-- An application is linked by at most one session.
CREATE UNIQUE INDEX automation_sessions_application_uniq ON automation_sessions (application_id)
  WHERE application_id IS NOT NULL;
```

- [ ] **Step 4: Write the failing RLS/constraint test**

`packages/db/src/automationSessionsTable.rls.test.ts`:
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
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @ai-career/db test -- automationSessionsTable`
Expected: PASS (5 tests). If a CHECK name differs in the error text, read the generated SQL — the names must match the schema file exactly.

- [ ] **Step 6: Migrate the dev database and run the whole db suite**

Run: `pnpm --filter @ai-career/db db:migrate && pnpm --filter @ai-career/db test`
Expected: migrations 0026/0027 applied; all db tests PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-phase-8-browser-automation-design.md packages/db
git commit -m "feat(db): automation_sessions table with RLS and one-active-session index (Phase 8)"
```

---
### Task 2: `packages/browser` scaffold, types, adapters, target resolution and submission detection

**Files:**
- Create: `packages/browser/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
- Exists (committed with the plan): `packages/browser/fixtures/greenhouse-v1-form.html`, `packages/browser/fixtures/lever-v1-form.html`
- Create: `packages/browser/src/types.ts`, `src/queue.ts`, `src/errors.ts`, `src/adapters/types.ts`, `src/adapters/greenhouse.ts`, `src/adapters/lever.ts`, `src/adapters/index.ts`, `src/adapters/resolveAutofillTarget.ts`, `src/detect/detectSubmission.ts`, `src/index.ts`
- Test: `src/adapters/adapters.test.ts`, `src/adapters/resolveAutofillTarget.test.ts`, `src/detect/detectSubmission.test.ts`

**Interfaces:**
- Produces (all exported from `@ai-career/browser`):
  - `AUTOMATION_STATUSES`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES`, `type AutomationStatus`, `isActiveStatus(s)`, `isTerminalStatus(s)`, `PORTALS`, `type Portal`.
  - Snapshot types `SnapshotControl`, `SnapshotOption {key,label,value}`, `SnapshotField {key,control,name,id,autocomplete,label,required,options}`, `FormSnapshot {url,formFound,fields}`.
  - `FILLABLE_CANONICALS`, `NEVER_FILL_CANONICALS`, `type FillableCanonical`, `type Canonical`, `type AutofillValue`, `type AutofillValues`, `type FillAction`, `type FieldAuditEntry`, `type FillPlan`.
  - `BROWSER_QUEUE_NAME = "browser-automation"`, `BROWSER_JOB_NAME = "run-autofill"`, `type BrowserJobData {sessionId,userId}`, `browserJobId(sessionId)`, `BROWSER_JOB_OPTIONS`.
  - `AutomationError(errorClass, detail?)`, `type AutomationErrorClass`.
  - `type PortalAdapter`, `type SnapshotConfig`, `greenhouseV1`, `leverV1`, `getAdapter(portal)`, `SAFE_IDENTIFIER`.
  - `resolveAutofillTarget(postings: PostingRef[]): AutofillTarget`, `type PostingRef`, `type AutofillTarget`, `type UnsupportedReason`.
  - `detectSubmission(adapter, {url, text, formUrl}): boolean`.

- [ ] **Step 1: Scaffold the package**

`packages/browser/package.json`:
```json
{
  "name": "@ai-career/browser",
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
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": {
    "@types/jsdom": "^21.1.7",
    "@types/node": "^22.10.0",
    "eslint": "^9.0.0",
    "jsdom": "^25.0.1",
    "postgres": "^3.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```
Copy `tsconfig.json`, `vitest.config.ts` and `eslint.config.mjs` verbatim from `packages/applications/` (same settings: strict, Bundler resolution, `fileParallelism: false`). Change the `vitest.config.ts` comment to say "Session tests migrate and share the test database." Run `pnpm install`.

- [ ] **Step 2: Write `src/types.ts`, `src/queue.ts`, `src/errors.ts`**

`packages/browser/src/types.ts`:
```ts
export const AUTOMATION_STATUSES = [
  "queued", "launching", "filling", "awaiting_user", "submission_detected", "abandoned", "needs_manual", "failed",
] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];
export const ACTIVE_STATUSES = ["queued", "launching", "filling", "awaiting_user"] as const satisfies readonly AutomationStatus[];
export const TERMINAL_STATUSES = ["submission_detected", "abandoned", "needs_manual", "failed"] as const satisfies readonly AutomationStatus[];
export const isActiveStatus = (s: AutomationStatus): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s);
export const isTerminalStatus = (s: AutomationStatus): boolean => (TERMINAL_STATUSES as readonly string[]).includes(s);

export const PORTALS = ["greenhouse", "lever"] as const;
export type Portal = (typeof PORTALS)[number];

/** What the in-page extractor reports for one control. Groups of radios/checkboxes become one field. */
export type SnapshotControl =
  | "text" | "email" | "tel" | "url" | "number" | "textarea" | "select"
  | "radio_group" | "checkbox_group" | "checkbox" | "file" | "combobox" | "other";

/** For radio/checkbox groups `key` is that option element's data-cp-key; for select options it is the select's key. */
export interface SnapshotOption {
  key: string;
  label: string;
  value: string;
}

/** `key` is the data-cp-key stamped on the element ("f3"), or a synthetic group key ("g9") for radio/checkbox groups. */
export interface SnapshotField {
  key: string;
  control: SnapshotControl;
  name: string | null;
  id: string | null;
  autocomplete: string | null;
  /** Untrusted page text, whitespace-collapsed, trailing "*"/"✱" removed, at most 200 chars. Only ever regex-matched. */
  label: string | null;
  required: boolean;
  options: SnapshotOption[];
}

export interface FormSnapshot {
  url: string;
  formFound: boolean;
  fields: SnapshotField[];
}

export const FILLABLE_CANONICALS = [
  "first_name", "last_name", "full_name", "email", "phone", "location", "linkedin", "resume", "cover_letter", "sponsorship", "salary_expectation",
] as const;
export type FillableCanonical = (typeof FILLABLE_CANONICALS)[number];
export const NEVER_FILL_CANONICALS = ["github", "website", "work_authorization", "eeo"] as const;
export type NeverFillCanonical = (typeof NEVER_FILL_CANONICALS)[number];
export type Canonical = FillableCanonical | NeverFillCanonical;
export const isNeverFill = (c: Canonical): c is NeverFillCanonical => (NEVER_FILL_CANONICALS as readonly string[]).includes(c);

/** `source` names where the value came from (e.g. "profile.email"); it is what the audit stores instead of the value. */
export type AutofillValue =
  | { kind: "text"; text: string; source: string }
  | { kind: "file"; file: "resume" | "cover_letter"; source: string }
  | { kind: "boolean"; value: boolean; source: string };
export type AutofillValues = Partial<Record<FillableCanonical, AutofillValue>>;

/** The only page mutations the worker can perform. There is deliberately no click/press/submit kind. */
export type FillAction =
  | { kind: "fill"; fieldKey: string; targetKey: string; text: string }
  | { kind: "selectOption"; fieldKey: string; targetKey: string; optionValue: string }
  | { kind: "check"; fieldKey: string; targetKey: string }
  | { kind: "setInputFiles"; fieldKey: string; targetKey: string; file: "resume" | "cover_letter" };

export type AuditAction = "filled" | "flagged" | "skipped";

/** Never carries a field value (CLAUDE.md §9). */
export interface FieldAuditEntry {
  key: string;
  label: string | null;
  required: boolean;
  canonical: Canonical | null;
  action: AuditAction;
  reason: string | null;
  valueSource: string | null;
  verified: boolean | null;
}

export interface FillPlan {
  healthy: boolean;
  /** Required canonicals not matched by exactly one field (empty when healthy). */
  missingForHealth: Canonical[];
  actions: FillAction[];
  audit: FieldAuditEntry[];
}
```

`packages/browser/src/queue.ts`:
```ts
export const BROWSER_QUEUE_NAME = "browser-automation";
export const BROWSER_JOB_NAME = "run-autofill";

export interface BrowserJobData {
  sessionId: string;
  userId: string;
}

export const browserJobId = (sessionId: string): string => `autofill-${sessionId}`;

/**
 * One attempt: a retry would open a second browser window for the same session. A stalled job that BullMQ
 * re-delivers is harmless -- the worker only claims a session still in `queued`.
 */
export const BROWSER_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: true };
```

`packages/browser/src/errors.ts`:
```ts
export type AutomationErrorClass =
  | "job_not_found" | "profile_missing" | "unsupported" | "session_active" | "not_found" | "not_cancellable";

/** Carries a class (and for `unsupported` a fixed reason code) only -- never user or page text -- so it is safe to log. */
export class AutomationError extends Error {
  readonly errorClass: AutomationErrorClass;
  readonly detail: string | null;
  constructor(errorClass: AutomationErrorClass, detail: string | null = null) {
    super(errorClass);
    this.name = "AutomationError";
    this.errorClass = errorClass;
    this.detail = detail;
  }
}
```

- [ ] **Step 3: Write the failing adapter, resolution and detection tests**

`packages/browser/src/adapters/adapters.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { greenhouseV1, leverV1, getAdapter } from "./index";

describe("adapters", () => {
  it("build canonical hosted form URLs", () => {
    expect(greenhouseV1.buildFormUrl({ slug: "acme", externalId: "1234567" })).toBe("https://job-boards.greenhouse.io/acme/jobs/1234567");
    expect(leverV1.buildFormUrl({ slug: "acme", externalId: "6ed76ce8-4156" })).toBe("https://jobs.lever.co/acme/6ed76ce8-4156/apply");
  });

  it("are looked up by portal and carry versions", () => {
    expect(getAdapter("greenhouse")).toBe(greenhouseV1);
    expect(getAdapter("lever")).toBe(leverV1);
    expect(greenhouseV1.version).toBe("greenhouse-v1");
    expect(leverV1.version).toBe("lever-v1");
  });

  it("only allow their own hosts", () => {
    expect(greenhouseV1.allowedHosts).toEqual(["job-boards.greenhouse.io", "boards.greenhouse.io"]);
    expect(leverV1.allowedHosts).toEqual(["jobs.lever.co"]);
  });
});
```

`packages/browser/src/adapters/resolveAutofillTarget.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveAutofillTarget, type PostingRef } from "./resolveAutofillTarget";

const ref = (over: Partial<PostingRef> = {}): PostingRef => ({
  sourceKind: "greenhouse", slug: "acme", externalId: "123", status: "open", lastSeenAt: new Date("2026-09-30T00:00:00Z"), ...over,
});

describe("resolveAutofillTarget", () => {
  it("picks the newest open Greenhouse/Lever posting", () => {
    const target = resolveAutofillTarget([
      ref({ externalId: "old", lastSeenAt: new Date("2026-09-01T00:00:00Z") }),
      ref({ sourceKind: "lever", slug: "acme", externalId: "new-id", lastSeenAt: new Date("2026-09-29T00:00:00Z") }),
      ref({ externalId: "closed", status: "closed", lastSeenAt: new Date("2026-09-30T12:00:00Z") }),
    ]);
    expect(target).toMatchObject({ supported: true, formUrl: "https://jobs.lever.co/acme/new-id/apply" });
    if (target.supported) expect(target.adapter.portal).toBe("lever");
  });

  it("is unsupported without an open Greenhouse/Lever posting", () => {
    expect(resolveAutofillTarget([])).toEqual({ supported: false, reason: "no_supported_posting" });
    expect(resolveAutofillTarget([ref({ sourceKind: "upload", slug: null })])).toEqual({ supported: false, reason: "no_supported_posting" });
    expect(resolveAutofillTarget([ref({ status: "closed" })])).toEqual({ supported: false, reason: "no_supported_posting" });
  });

  it("rejects identifiers that are not plain slugs", () => {
    expect(resolveAutofillTarget([ref({ slug: "acme/../evil" })])).toEqual({ supported: false, reason: "invalid_identifiers" });
    expect(resolveAutofillTarget([ref({ externalId: "1?x=y" })])).toEqual({ supported: false, reason: "invalid_identifiers" });
    expect(resolveAutofillTarget([ref({ slug: null })])).toEqual({ supported: false, reason: "invalid_identifiers" });
  });

  it("skips an invalid posting when a valid one exists", () => {
    const target = resolveAutofillTarget([
      ref({ slug: "bad slug", lastSeenAt: new Date("2026-09-30T00:00:00Z") }),
      ref({ externalId: "777", lastSeenAt: new Date("2026-09-01T00:00:00Z") }),
    ]);
    expect(target).toMatchObject({ supported: true, formUrl: "https://job-boards.greenhouse.io/acme/jobs/777" });
  });
});
```

`packages/browser/src/detect/detectSubmission.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { detectSubmission } from "./detectSubmission";
import { greenhouseV1, leverV1 } from "../adapters";

const GH_FORM = "https://job-boards.greenhouse.io/acme/jobs/123";
const LV_FORM = "https://jobs.lever.co/acme/abc/apply";

describe("detectSubmission", () => {
  it("detects the Greenhouse confirmation URL", () => {
    expect(detectSubmission(greenhouseV1, { url: `${GH_FORM}/confirmation`, text: "", formUrl: GH_FORM })).toBe(true);
  });

  it("detects the Lever thanks URL", () => {
    expect(detectSubmission(leverV1, { url: "https://jobs.lever.co/acme/abc/thanks", text: "", formUrl: LV_FORM })).toBe(true);
  });

  it("detects thanks text only away from the form URL", () => {
    const text = "Thank you for applying to Acme!";
    expect(detectSubmission(greenhouseV1, { url: `${GH_FORM}?step=done`, text, formUrl: GH_FORM })).toBe(true);
    expect(detectSubmission(greenhouseV1, { url: GH_FORM, text, formUrl: GH_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: "https://jobs.lever.co/acme/abc", text: "Application submitted!", formUrl: LV_FORM })).toBe(true);
  });

  it("ignores other hosts, the form itself and unparsable URLs", () => {
    expect(detectSubmission(greenhouseV1, { url: "https://evil.example/confirmation", text: "Thank you for applying", formUrl: GH_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: LV_FORM, text: "Submit your application", formUrl: LV_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: "about:blank", text: "", formUrl: LV_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: "not a url", text: "", formUrl: LV_FORM })).toBe(false);
  });

  it("works for a local fixture host (tests serve forms from 127.0.0.1)", () => {
    const form = "http://127.0.0.1:4555/greenhouse";
    expect(detectSubmission(greenhouseV1, { url: "http://127.0.0.1:4555/greenhouse/confirmation", text: "", formUrl: form })).toBe(true);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @ai-career/browser test`
Expected: FAIL — modules `./index`, `./resolveAutofillTarget`, `./detectSubmission` not found.

- [ ] **Step 5: Implement the adapters**

`packages/browser/src/adapters/types.ts`:
```ts
import type { Canonical, Portal } from "../types";

/** A field matches when any listed pattern matches its id, name or label. */
export interface FieldMatcher {
  ids?: RegExp[];
  names?: RegExp[];
  labels?: RegExp[];
}

export interface StandardFieldRule {
  canonical: Canonical;
  match: FieldMatcher;
  /** When set, a matching field is never filled; this reason goes into the audit (e.g. "autocomplete_widget"). */
  flagReason?: string;
}

/** Selectors the in-page extractor uses (see snapshot/extractSnapshotSource.ts). */
export interface SnapshotConfig {
  formSelector: string;
  /** Closest ancestor that holds one question; its `questionLabel` element is the question text. */
  questionContainer: string;
  questionLabel: string;
}

export interface FormUrlInput {
  slug: string;
  externalId: string;
}

/** D4/D127: versioned per-ATS adapters. Everything portal-specific lives here; the rest of the pipeline is shared. */
export interface PortalAdapter {
  portal: Portal;
  version: string;
  allowedHosts: readonly string[];
  buildFormUrl(input: FormUrlInput): string;
  snapshotConfig: SnapshotConfig;
  /** Health check: each must be matched by exactly one field, or nothing is filled. */
  requiredCanonicals: readonly Canonical[];
  standardFields: readonly StandardFieldRule[];
  /** urlPatterns are tested against the URL pathname; textPatterns against visible page text. */
  confirmation: { urlPatterns: readonly RegExp[]; textPatterns: readonly RegExp[] };
}

/** Board slugs and posting ids are interpolated into URLs: only plain identifier characters are accepted. */
export const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
```

`packages/browser/src/adapters/greenhouse.ts`:
```ts
import type { PortalAdapter } from "./types";

/**
 * The hosted job-boards.greenhouse.io form (inspected 2026-10-01; sanitized copy in fixtures/greenhouse-v1-form.html).
 * Standard fields have stable ids. Yes/no questions, country and EEO are react-select comboboxes, which are never
 * filled (choosing an option needs a click), so they always end up flagged or skipped.
 */
export const greenhouseV1: PortalAdapter = {
  portal: "greenhouse",
  version: "greenhouse-v1",
  allowedHosts: ["job-boards.greenhouse.io", "boards.greenhouse.io"],
  buildFormUrl: ({ slug, externalId }) =>
    `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
  snapshotConfig: { formSelector: "form#application-form", questionContainer: ".field-wrapper", questionLabel: "label" },
  requiredCanonicals: ["first_name", "last_name", "email", "resume"],
  standardFields: [
    { canonical: "first_name", match: { ids: [/^first_name$/] } },
    { canonical: "last_name", match: { ids: [/^last_name$/] } },
    { canonical: "email", match: { ids: [/^email$/] } },
    { canonical: "phone", match: { ids: [/^phone$/] } },
    { canonical: "resume", match: { ids: [/^resume$/] } },
    { canonical: "cover_letter", match: { ids: [/^cover_letter$/] } },
  ],
  confirmation: {
    urlPatterns: [/\/confirmation(?:\/|$)/],
    textPatterns: [/thank you for applying/i, /application (?:has been )?(?:received|submitted)/i],
  },
};
```

`packages/browser/src/adapters/lever.ts`:
```ts
import type { PortalAdapter } from "./types";

/**
 * The hosted jobs.lever.co/{slug}/{id}/apply form (inspected 2026-10-01; sanitized copy in fixtures/lever-v1-form.html).
 * Standard fields are identified by `name`. The location input is an autocomplete widget backed by a hidden
 * selectedLocation, so it is flagged rather than typed into. There is no cover-letter file input.
 */
export const leverV1: PortalAdapter = {
  portal: "lever",
  version: "lever-v1",
  allowedHosts: ["jobs.lever.co"],
  buildFormUrl: ({ slug, externalId }) =>
    `https://jobs.lever.co/${encodeURIComponent(slug)}/${encodeURIComponent(externalId)}/apply`,
  snapshotConfig: { formSelector: "form#application-form", questionContainer: "li.application-question", questionLabel: ".application-label" },
  requiredCanonicals: ["full_name", "email", "resume"],
  standardFields: [
    { canonical: "resume", match: { names: [/^resume$/] } },
    { canonical: "full_name", match: { names: [/^name$/] } },
    { canonical: "email", match: { names: [/^email$/] } },
    { canonical: "phone", match: { names: [/^phone$/] } },
    { canonical: "location", match: { names: [/^location$/] }, flagReason: "autocomplete_widget" },
    { canonical: "linkedin", match: { names: [/^urls\[LinkedIn\]$/] } },
    { canonical: "github", match: { names: [/^urls\[GitHub\]$/] } },
    { canonical: "website", match: { names: [/^urls\[(?:Portfolio|Other|Twitter)\]$/] } },
  ],
  confirmation: {
    urlPatterns: [/\/thanks(?:\/|$)/],
    textPatterns: [/application submitted/i, /thank you for (?:applying|your application)/i],
  },
};
```

`packages/browser/src/adapters/index.ts`:
```ts
import type { Portal } from "../types";
import type { PortalAdapter } from "./types";
import { greenhouseV1 } from "./greenhouse";
import { leverV1 } from "./lever";

export { greenhouseV1, leverV1 };
export { SAFE_IDENTIFIER, type PortalAdapter, type SnapshotConfig, type StandardFieldRule, type FieldMatcher, type FormUrlInput } from "./types";

const ADAPTERS: Record<Portal, PortalAdapter> = { greenhouse: greenhouseV1, lever: leverV1 };

export const getAdapter = (portal: Portal): PortalAdapter => ADAPTERS[portal];
```

`packages/browser/src/adapters/resolveAutofillTarget.ts`:
```ts
import type { PortalAdapter } from "./types";
import { SAFE_IDENTIFIER } from "./types";
import { greenhouseV1 } from "./greenhouse";
import { leverV1 } from "./lever";

/** One posting of a job, joined with its source. `slug` comes from job_sources.config. */
export interface PostingRef {
  sourceKind: "greenhouse" | "lever" | "upload";
  slug: string | null;
  externalId: string;
  status: "open" | "closed";
  lastSeenAt: Date;
}

export type UnsupportedReason = "no_supported_posting" | "invalid_identifiers";
export type AutofillTarget =
  | { supported: true; adapter: PortalAdapter; formUrl: string }
  | { supported: false; reason: UnsupportedReason };

const BY_KIND = { greenhouse: greenhouseV1, lever: leverV1 } as const;

/**
 * Design §4.1: the form URL is built from the source's board slug and the posting's external id, never taken
 * from the scraped posting URL (often a company page that iframes the form). Newest open posting wins.
 */
export function resolveAutofillTarget(postings: PostingRef[]): AutofillTarget {
  const candidates = postings
    .filter((p) => p.status === "open" && (p.sourceKind === "greenhouse" || p.sourceKind === "lever"))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  if (candidates.length === 0) return { supported: false, reason: "no_supported_posting" };
  for (const p of candidates) {
    if (p.slug === null || !SAFE_IDENTIFIER.test(p.slug) || !SAFE_IDENTIFIER.test(p.externalId)) continue;
    const adapter = BY_KIND[p.sourceKind as "greenhouse" | "lever"];
    return { supported: true, adapter, formUrl: adapter.buildFormUrl({ slug: p.slug, externalId: p.externalId }) };
  }
  return { supported: false, reason: "invalid_identifiers" };
}
```

`packages/browser/src/detect/detectSubmission.ts`:
```ts
import type { PortalAdapter } from "../adapters/types";

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};
const withoutHash = (u: URL): string => `${u.origin}${u.pathname}${u.search}`;

/**
 * Design §4.6. Only a hint -- recording an application still needs the user's click. A page counts when it is on
 * the form's own host and either its path matches a confirmation pattern, or (away from the form URL itself) its
 * visible text does.
 */
export function detectSubmission(adapter: PortalAdapter, page: { url: string; text: string; formUrl: string }): boolean {
  const url = parse(page.url);
  const form = parse(page.formUrl);
  if (!url || !form || url.host !== form.host) return false;
  if (adapter.confirmation.urlPatterns.some((p) => p.test(url.pathname))) return true;
  if (withoutHash(url) === withoutHash(form)) return false;
  return adapter.confirmation.textPatterns.some((p) => p.test(page.text));
}
```

`packages/browser/src/index.ts` (later tasks append to it):
```ts
export * from "./types";
export * from "./queue";
export { AutomationError, type AutomationErrorClass } from "./errors";
export {
  greenhouseV1, leverV1, getAdapter, SAFE_IDENTIFIER,
  type PortalAdapter, type SnapshotConfig, type StandardFieldRule, type FieldMatcher, type FormUrlInput,
} from "./adapters";
export { resolveAutofillTarget, type PostingRef, type AutofillTarget, type UnsupportedReason } from "./adapters/resolveAutofillTarget";
export { detectSubmission } from "./detect/detectSubmission";
```

- [ ] **Step 6: Run the tests, typecheck and lint**

Run: `pnpm --filter @ai-career/browser test && pnpm --filter @ai-career/browser typecheck && pnpm --filter @ai-career/browser lint`
Expected: all PASS, no type or lint errors.

- [ ] **Step 7: Commit**

```bash
git add packages/browser pnpm-lock.yaml
git commit -m "feat(browser): package scaffold, Greenhouse/Lever adapters, target resolution, submission detection"
```

---

### Task 3: In-page snapshot extractor (tested in jsdom against the real forms)

**Files:**
- Create: `packages/browser/src/snapshot/extractSnapshotSource.ts`, `packages/browser/src/testing/snapshotFromHtml.ts`, `packages/browser/src/testing/index.ts`
- Modify: `packages/browser/src/index.ts`
- Test: `packages/browser/src/snapshot/extractSnapshot.test.ts`

**Interfaces:**
- Consumes: `SnapshotConfig` (Task 2), `FormSnapshot` (Task 2), adapters' `snapshotConfig`.
- Produces: `EXTRACT_SNAPSHOT_SOURCE: string` (a JS function expression `function (config) {...}` returning `FormSnapshot`; stamps `data-cp-key` on every reported element); `snapshotFromHtml(html, config, url?) : FormSnapshot` and `readFixture(name)` from `@ai-career/browser/testing`.

- [ ] **Step 1: Write the failing test**

`packages/browser/src/snapshot/extractSnapshot.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { snapshotFromHtml, readFixture } from "../testing";
import { greenhouseV1, leverV1 } from "../adapters";
import type { SnapshotField } from "../types";

const byId = (fields: SnapshotField[], id: string) => fields.find((f) => f.id === id);
const byName = (fields: SnapshotField[], name: string) => fields.find((f) => f.name === name);

describe("EXTRACT_SNAPSHOT_SOURCE on the Greenhouse fixture", () => {
  const snap = snapshotFromHtml(readFixture("greenhouse-v1-form.html"), greenhouseV1.snapshotConfig);

  it("finds the form and its 21 visible controls", () => {
    expect(snap.formFound).toBe(true);
    expect(snap.fields).toHaveLength(21);
  });

  it("reads labels from label[for], aria-labelledby and strips the required star", () => {
    expect(byId(snap.fields, "first_name")).toMatchObject({ control: "text", label: "First Name", required: true });
    expect(byId(snap.fields, "phone")).toMatchObject({ control: "tel", label: "Phone", required: false });
    expect(byId(snap.fields, "resume")).toMatchObject({ control: "file" });
    expect(byId(snap.fields, "question_36622854002")).toMatchObject({ control: "text", label: "LinkedIn Profile" });
    expect(byId(snap.fields, "question_36622859002")).toMatchObject({
      control: "combobox",
      label: "Will you now or in the future require sponsorship for a visa to remain in your current location?",
      required: true,
    });
    expect(byId(snap.fields, "gender")).toMatchObject({ control: "combobox", label: "Gender" });
  });

  it("skips react-select's aria-hidden validation inputs", () => {
    expect(snap.fields.every((f) => f.id !== null)).toBe(true);
  });

  it("gives every field a unique key", () => {
    expect(new Set(snap.fields.map((f) => f.key)).size).toBe(snap.fields.length);
  });
});

describe("EXTRACT_SNAPSHOT_SOURCE on the Lever fixture", () => {
  const snap = snapshotFromHtml(readFixture("lever-v1-form.html"), leverV1.snapshotConfig);

  it("finds the form and groups radios/checkboxes", () => {
    expect(snap.formFound).toBe(true);
    expect(snap.fields).toHaveLength(22);
  });

  it("labels standard fields from the question container", () => {
    expect(byName(snap.fields, "resume")).toMatchObject({ control: "file", label: "Resume/CV" });
    expect(byName(snap.fields, "name")).toMatchObject({ control: "text", label: "Full name", required: true });
    expect(byName(snap.fields, "email")).toMatchObject({ control: "email", required: true });
    expect(byName(snap.fields, "location")).toMatchObject({ control: "text", label: "Current location", required: true });
    expect(byName(snap.fields, "urls[LinkedIn]")).toMatchObject({ control: "text", label: "LinkedIn URL" });
  });

  it("reports a yes/no radio group as one field with option keys and labels", () => {
    const sponsorship = snap.fields.find((f) => f.label?.startsWith("Will you now or in the future require sponsorship"));
    expect(sponsorship).toMatchObject({ control: "radio_group", required: true });
    expect(sponsorship!.options.map((o) => [o.label, o.value])).toEqual([["Yes", "Yes"], ["No", "No"]]);
    expect(sponsorship!.options.every((o) => /^f\d+$/.test(o.key))).toBe(true);
  });

  it("reports selects with their options and multi-checkboxes as a checkbox group", () => {
    const heard = snap.fields.find((f) => f.label === "Please tell us how you heard about this opportunity.");
    expect(heard).toMatchObject({ control: "select", required: true });
    expect(heard!.options[0]).toMatchObject({ label: "Select...", value: "" });
    expect(snap.fields.find((f) => f.label?.startsWith("Language Skill(s)"))).toMatchObject({ control: "checkbox_group", required: true });
  });
});

describe("EXTRACT_SNAPSHOT_SOURCE edge cases", () => {
  it("reports formFound false when the form selector matches nothing", () => {
    expect(snapshotFromHtml("<html><body><p>Gone</p></body></html>", greenhouseV1.snapshotConfig)).toEqual({
      url: "https://example.test/form", formFound: false, fields: [],
    });
  });

  it("never reports buttons, submit/hidden inputs or disabled controls", () => {
    const html = `<form id="application-form">
      <input type="submit" value="Go"><input type="hidden" name="t"><input type="text" name="x" disabled>
      <button type="button">Next</button><input type="text" name="kept" aria-label="Kept *"></form>`;
    const snap = snapshotFromHtml(html, greenhouseV1.snapshotConfig);
    expect(snap.fields.map((f) => [f.name, f.label])).toEqual([["kept", "Kept"]]);
  });

  it("stamps data-cp-key on the reported elements", () => {
    const snap = snapshotFromHtml(`<form id="application-form"><input id="first_name"></form>`, greenhouseV1.snapshotConfig);
    expect(snap.fields[0].key).toBe("f0");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/browser test -- extractSnapshot`
Expected: FAIL — `../testing` not found.

- [ ] **Step 3: Implement the extractor and the jsdom helper**

`packages/browser/src/snapshot/extractSnapshotSource.ts` (the string body was validated against both fixtures while planning; keep it ES5 and self-contained):
```ts
/**
 * Design §4.2. Plain-JS source of `function (config) => FormSnapshot`, evaluated inside the application page
 * (`page.evaluate` in the worker, `window.eval` in jsdom tests). It is a string, not a TS function, because tsx's
 * esbuild `keepNames` would inject `__name(...)` calls that do not exist in the page (DECISIONS D131).
 *
 * It stamps `data-cp-key` on every reported element so the worker can address it as `[data-cp-key="f3"]`.
 * Label text is untrusted page content: it is only ever regex-matched, never sent to a model.
 * Uses textContent (not innerText) so jsdom and Chrome agree.
 */
export const EXTRACT_SNAPSHOT_SOURCE = String.raw`function (config) {
  var form = document.querySelector(config.formSelector);
  if (!form) return { url: String(location.href), formFound: false, fields: [] };
  var SKIP_TYPES = { hidden: true, submit: true, button: true, image: true, reset: true };
  var counter = 0;
  function clean(text) {
    if (text === null || text === undefined) return null;
    var t = String(text).replace(/\s+/g, " ").trim().replace(/[\s*✱]+$/, "").trim();
    return t ? t.slice(0, 200) : null;
  }
  function textOf(el) { return el ? clean(el.textContent) : null; }
  function byIds(ids) {
    if (!ids) return null;
    var parts = ids.split(/\s+/).map(function (id) { var e = document.getElementById(id); return e ? e.textContent : ""; });
    return clean(parts.join(" "));
  }
  function labelForId(id) {
    if (!id) return null;
    var labels = form.querySelectorAll("label[for]");
    for (var i = 0; i < labels.length; i++) if (labels[i].getAttribute("for") === id) return textOf(labels[i]);
    return null;
  }
  function questionLabel(el) {
    var container = el.closest(config.questionContainer);
    if (!container) return null;
    return textOf(container.querySelector(config.questionLabel));
  }
  function labelOf(el) {
    return byIds(el.getAttribute("aria-labelledby")) || labelForId(el.id) || clean(el.getAttribute("aria-label")) ||
      questionLabel(el) || textOf(el.closest("label"));
  }
  function groupLabelOf(el) {
    var fieldset = el.closest("fieldset");
    return questionLabel(el) || (fieldset ? textOf(fieldset.querySelector("legend")) : null);
  }
  function controlOf(el) {
    var tag = el.tagName.toLowerCase();
    if (el.getAttribute("role") === "combobox" || el.hasAttribute("aria-autocomplete")) return "combobox";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "text" || type === "search") return "text";
    if (["email", "tel", "url", "number", "file", "checkbox", "radio"].indexOf(type) >= 0) return type;
    return "other";
  }
  function isRequired(el) {
    return el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
  }
  function stamp(el) { var key = "f" + counter++; el.setAttribute("data-cp-key", key); return key; }
  var fields = [];
  var groups = {};
  var elements = form.querySelectorAll("input, select, textarea");
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (SKIP_TYPES[type] || el.disabled || el.getAttribute("aria-hidden") === "true") continue;
    var control = controlOf(el);
    var name = el.getAttribute("name");
    if ((control === "radio" || control === "checkbox") && name) {
      var group = groups[name];
      if (!group) {
        group = { key: "g" + counter++, control: control === "radio" ? "radio_group" : "checkbox_group", name: name, id: null,
          autocomplete: null, label: groupLabelOf(el), required: false, options: [] };
        groups[name] = group;
        fields.push(group);
      }
      group.required = group.required || isRequired(el);
      group.options.push({ key: stamp(el), label: textOf(el.closest("label")) || clean(el.getAttribute("aria-label")) || "", value: el.value });
      continue;
    }
    var field = { key: stamp(el), control: control, name: name, id: el.id || null, autocomplete: el.getAttribute("autocomplete"),
      label: labelOf(el), required: isRequired(el), options: [] };
    if (control === "select") {
      for (var j = 0; j < el.options.length; j++) {
        var opt = el.options[j];
        field.options.push({ key: field.key, label: clean(opt.textContent) || "", value: opt.value });
      }
    }
    fields.push(field);
  }
  for (var n in groups) if (groups[n].control === "checkbox_group" && groups[n].options.length === 1) groups[n].control = "checkbox";
  return { url: String(location.href), formFound: true, fields: fields };
}`;
```

`packages/browser/src/testing/snapshotFromHtml.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { EXTRACT_SNAPSHOT_SOURCE } from "../snapshot/extractSnapshotSource";
import type { SnapshotConfig } from "../adapters/types";
import type { FormSnapshot } from "../types";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

/** Sanitized copies of the live forms (captured 2026-10-01). */
export const readFixture = (name: "greenhouse-v1-form.html" | "lever-v1-form.html"): string =>
  readFileSync(path.join(FIXTURES, name), "utf8");

/** Runs the real in-page extractor in jsdom. JSON round-trip: values from the jsdom realm compare cleanly. */
export function snapshotFromHtml(html: string, config: SnapshotConfig, url = "https://example.test/form"): FormSnapshot {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  try {
    const result = dom.window.eval(`(${EXTRACT_SNAPSHOT_SOURCE})(${JSON.stringify(config)})`);
    return JSON.parse(JSON.stringify(result)) as FormSnapshot;
  } finally {
    dom.window.close();
  }
}
```

`packages/browser/src/testing/index.ts`:
```ts
export { snapshotFromHtml, readFixture } from "./snapshotFromHtml";
```

Append to `packages/browser/src/index.ts`:
```ts
export { EXTRACT_SNAPSHOT_SOURCE } from "./snapshot/extractSnapshotSource";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @ai-career/browser test -- extractSnapshot`
Expected: PASS (all). If a count differs from 21/22, print `snap.fields.map(f => [f.key, f.control, f.id ?? f.name, f.label])` and compare against the fixture before changing the expectation — the counts were produced by this exact source on these exact fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/browser
git commit -m "feat(browser): in-page form snapshot extractor, tested in jsdom against sanitized live forms"
```

---

### Task 4: Values, field classification and the fill plan

**Files:**
- Create: `packages/browser/src/values/buildAutofillValues.ts`, `packages/browser/src/plan/classifyField.ts`, `packages/browser/src/plan/buildFillPlan.ts`
- Modify: `packages/browser/src/index.ts`
- Test: `packages/browser/src/values/buildAutofillValues.test.ts`, `packages/browser/src/plan/classifyField.test.ts`, `packages/browser/src/plan/buildFillPlan.test.ts`

**Interfaces:**
- Consumes: Task 2 types/adapters, Task 3 `snapshotFromHtml`/`readFixture` (tests only).
- Produces:
  - `type AutofillInput = { profile: {fullName,email,phoneNumber,linkedinUrl,addressLine1}; goal: {visaSponsorshipRequired: boolean|null; salaryTargetNormalized: string|null; salaryTargetCurrency: string|null; salaryTargetIsParsed: boolean} | null; attachments: {resume: boolean; coverLetter: boolean} }`
  - `buildAutofillValues(input: AutofillInput): AutofillValues`
  - `classifyField(field, adapter): { canonical: Canonical; flagReason: string | null } | null`
  - `buildFillPlan(snapshot: FormSnapshot, adapter: PortalAdapter, values: AutofillValues): FillPlan`

- [ ] **Step 1: Write the failing tests**

`packages/browser/src/values/buildAutofillValues.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildAutofillValues, type AutofillInput } from "./buildAutofillValues";

const input = (over: Partial<AutofillInput> = {}): AutofillInput => ({
  profile: { fullName: "Jane van Doe", email: " jane@example.com ", phoneNumber: "+49 30 1234", linkedinUrl: "https://linkedin.com/in/jane", addressLine1: "Berlin" },
  goal: { visaSponsorshipRequired: false, salaryTargetNormalized: "85000.00", salaryTargetCurrency: "EUR", salaryTargetIsParsed: true },
  attachments: { resume: true, coverLetter: false },
  ...over,
});

describe("buildAutofillValues", () => {
  it("maps profile fields and splits the name on the last whitespace", () => {
    const v = buildAutofillValues(input());
    expect(v.full_name).toEqual({ kind: "text", text: "Jane van Doe", source: "profile.fullName" });
    expect(v.first_name).toEqual({ kind: "text", text: "Jane van", source: "profile.fullName" });
    expect(v.last_name).toEqual({ kind: "text", text: "Doe", source: "profile.fullName" });
    expect(v.email).toEqual({ kind: "text", text: "jane@example.com", source: "profile.email" });
    expect(v.phone?.source).toBe("profile.phoneNumber");
    expect(v.linkedin?.source).toBe("profile.linkedinUrl");
    expect(v.location).toEqual({ kind: "text", text: "Berlin", source: "profile.addressLine1" });
  });

  it("leaves first/last name out for a single-token name and drops blank optional fields", () => {
    const v = buildAutofillValues(input({ profile: { fullName: "Cher", email: "c@example.com", phoneNumber: "  ", linkedinUrl: null, addressLine1: null } }));
    expect(v.full_name?.kind).toBe("text");
    expect(v.first_name).toBeUndefined();
    expect(v.last_name).toBeUndefined();
    expect(v.phone).toBeUndefined();
    expect(v.linkedin).toBeUndefined();
    expect(v.location).toBeUndefined();
  });

  it("offers attachments only when they exist", () => {
    expect(buildAutofillValues(input()).resume).toEqual({ kind: "file", file: "resume", source: "generated_documents.resume" });
    expect(buildAutofillValues(input()).cover_letter).toBeUndefined();
    expect(buildAutofillValues(input({ attachments: { resume: false, coverLetter: true } })).cover_letter?.kind).toBe("file");
  });

  it("answers sponsorship only from a non-null goal flag", () => {
    expect(buildAutofillValues(input()).sponsorship).toEqual({ kind: "boolean", value: false, source: "goal.visaSponsorshipRequired" });
    expect(buildAutofillValues(input({ goal: null })).sponsorship).toBeUndefined();
    const unknown = input();
    unknown.goal!.visaSponsorshipRequired = null;
    expect(buildAutofillValues(unknown).sponsorship).toBeUndefined();
  });

  it("uses the parsed salary target only (never the floor)", () => {
    expect(buildAutofillValues(input()).salary_expectation).toEqual({ kind: "text", text: "85000 EUR", source: "goal.salaryTarget" });
    const unparsed = input();
    unparsed.goal!.salaryTargetIsParsed = false;
    expect(buildAutofillValues(unparsed).salary_expectation).toBeUndefined();
    const noCurrency = input();
    noCurrency.goal!.salaryTargetCurrency = null;
    expect(buildAutofillValues(noCurrency).salary_expectation).toBeUndefined();
  });
});
```

`packages/browser/src/plan/classifyField.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { classifyField } from "./classifyField";
import { greenhouseV1, leverV1 } from "../adapters";
import type { SnapshotField } from "../types";

const field = (over: Partial<SnapshotField>): SnapshotField => ({
  key: "f0", control: "text", name: null, id: null, autocomplete: null, label: null, required: false, options: [], ...over,
});

describe("classifyField", () => {
  it("uses the adapter's standard rules first", () => {
    expect(classifyField(field({ id: "first_name", label: "First Name" }), greenhouseV1)).toEqual({ canonical: "first_name", flagReason: null });
    expect(classifyField(field({ name: "location" }), leverV1)).toEqual({ canonical: "location", flagReason: "autocomplete_widget" });
    expect(classifyField(field({ name: "urls[GitHub]" }), leverV1)).toEqual({ canonical: "github", flagReason: null });
  });

  it("falls back to shared label rules", () => {
    const c = (label: string) => classifyField(field({ label }), greenhouseV1)?.canonical ?? null;
    expect(c("LinkedIn Profile")).toBe("linkedin");
    expect(c("Will you now or in the future require sponsorship for a visa?")).toBe("sponsorship");
    expect(c("Are you legally authorized to work in the country for which you are applying?")).toBe("work_authorization");
    expect(c("Are you authorized to work in the US without sponsorship?")).toBe("work_authorization");
    expect(c("Are you a Ruritania citizen?")).toBe("work_authorization");
    expect(c("What are your salary expectations?")).toBe("salary_expectation");
    expect(c("Desired compensation")).toBe("salary_expectation");
    expect(c("Gender")).toBe("eeo");
    expect(c("Are you Hispanic/Latino?")).toBe("eeo");
    expect(c("Veteran Status")).toBe("eeo");
    expect(c("GitHub URL")).toBe("github");
    expect(c("Portfolio URL")).toBe("website");
    expect(c("Why do you want to work at Acme?")).toBeNull();
    expect(c("Have you previously worked at or consulted for Acme?")).toBeNull();
  });

  it("returns null for a field without id/name/label matches", () => {
    expect(classifyField(field({}), leverV1)).toBeNull();
  });
});
```

`packages/browser/src/plan/buildFillPlan.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildFillPlan } from "./buildFillPlan";
import { buildAutofillValues, type AutofillInput } from "../values/buildAutofillValues";
import { greenhouseV1, leverV1 } from "../adapters";
import { snapshotFromHtml, readFixture } from "../testing";
import type { FieldAuditEntry, FormSnapshot, SnapshotField } from "../types";

const INPUT: AutofillInput = {
  profile: { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: "+49 30 1234", linkedinUrl: "https://linkedin.com/in/jane", addressLine1: "Berlin" },
  goal: { visaSponsorshipRequired: false, salaryTargetNormalized: "85000", salaryTargetCurrency: "EUR", salaryTargetIsParsed: true },
  attachments: { resume: true, coverLetter: true },
};
const values = buildAutofillValues(INPUT);
const gh = snapshotFromHtml(readFixture("greenhouse-v1-form.html"), greenhouseV1.snapshotConfig);
const lv = snapshotFromHtml(readFixture("lever-v1-form.html"), leverV1.snapshotConfig);

const auditFor = (audit: FieldAuditEntry[], snap: FormSnapshot, pick: (f: SnapshotField) => boolean) => {
  const key = snap.fields.find(pick)!.key;
  return audit.find((a) => a.key === key)!;
};

describe("buildFillPlan on the Greenhouse fixture", () => {
  const plan = buildFillPlan(gh, greenhouseV1, values);

  it("is healthy and fills exactly the confident fields", () => {
    expect(plan.healthy).toBe(true);
    const filled = plan.audit.filter((a) => a.action === "filled").map((a) => a.canonical).sort();
    expect(filled).toEqual(["cover_letter", "email", "first_name", "last_name", "linkedin", "phone", "resume"]);
    expect(plan.actions).toHaveLength(7);
    expect(plan.actions.find((a) => a.kind === "setInputFiles" && a.file === "resume")).toBeDefined();
  });

  it("flags the sponsorship combobox and required unknown comboboxes", () => {
    expect(auditFor(plan.audit, gh, (f) => f.id === "question_36622859002")).toMatchObject({
      canonical: "sponsorship", action: "flagged", reason: "unsupported_control",
    });
    expect(auditFor(plan.audit, gh, (f) => f.id === "question_36622860002")).toMatchObject({ canonical: null, action: "flagged", reason: "unrecognized" });
  });

  it("skips optional EEO and unknown optional fields", () => {
    expect(auditFor(plan.audit, gh, (f) => f.id === "gender")).toMatchObject({ canonical: "eeo", action: "skipped", reason: "intentionally_not_filled" });
    expect(auditFor(plan.audit, gh, (f) => f.id === "question_36622855002")).toMatchObject({ action: "skipped", reason: "unrecognized" });
  });

  it("audits every field exactly once", () => {
    expect(plan.audit.map((a) => a.key).sort()).toEqual(gh.fields.map((f) => f.key).sort());
  });
});

describe("buildFillPlan on the Lever fixture", () => {
  const plan = buildFillPlan(lv, leverV1, values);

  it("is healthy and answers the yes/no sponsorship radio group from the goal", () => {
    expect(plan.healthy).toBe(true);
    const sponsorship = lv.fields.find((f) => f.label?.startsWith("Will you now or in the future require sponsorship"))!;
    const no = sponsorship.options.find((o) => o.label === "No")!;
    expect(plan.actions).toContainEqual({ kind: "check", fieldKey: sponsorship.key, targetKey: no.key });
    expect(auditFor(plan.audit, lv, (f) => f.key === sponsorship.key)).toMatchObject({ action: "filled", valueSource: "goal.visaSponsorshipRequired" });
  });

  it("fills standard fields and flags the location widget and work authorization", () => {
    const filled = plan.audit.filter((a) => a.action === "filled").map((a) => a.canonical).sort();
    expect(filled).toEqual(["email", "full_name", "linkedin", "phone", "resume", "sponsorship"]);
    expect(auditFor(plan.audit, lv, (f) => f.name === "location")).toMatchObject({ action: "flagged", reason: "autocomplete_widget" });
    expect(auditFor(plan.audit, lv, (f) => f.label?.startsWith("Are you legally authorized") ?? false)).toMatchObject({
      canonical: "work_authorization", action: "flagged", reason: "not_auto_filled",
    });
    expect(auditFor(plan.audit, lv, (f) => f.name === "urls[GitHub]")).toMatchObject({ action: "skipped", reason: "not_auto_filled" });
  });
});

describe("buildFillPlan rules", () => {
  const f = (over: Partial<SnapshotField>): SnapshotField => ({
    key: "f0", control: "text", name: null, id: null, autocomplete: null, label: null, required: false, options: [], ...over,
  });
  const snap = (fields: SnapshotField[], formFound = true): FormSnapshot => ({ url: "https://x.test", formFound, fields });
  const healthyGh = [
    f({ key: "f1", id: "first_name" }), f({ key: "f2", id: "last_name" }), f({ key: "f3", id: "email" }), f({ key: "f4", id: "resume", control: "file" }),
  ];

  it("fails the health check when a required canonical is missing or the form is absent, and fills nothing", () => {
    const missing = buildFillPlan(snap(healthyGh.slice(0, 3)), greenhouseV1, values);
    expect(missing).toMatchObject({ healthy: false, missingForHealth: ["resume"], actions: [] });
    expect(missing.audit.every((a) => a.action === "skipped" && a.reason === "health_check_failed")).toBe(true);
    expect(buildFillPlan(snap([], false), greenhouseV1, values)).toMatchObject({ healthy: false, actions: [] });
  });

  it("flags ambiguous matches instead of guessing", () => {
    const plan = buildFillPlan(snap([...healthyGh, f({ key: "f5", label: "LinkedIn" }), f({ key: "f6", label: "LinkedIn profile URL" })]), greenhouseV1, values);
    expect(plan.audit.filter((a) => a.canonical === "linkedin").map((a) => a.reason)).toEqual(["ambiguous_match", "ambiguous_match"]);
  });

  it("flags a missing resume export even though the field is optional", () => {
    const noResume = buildAutofillValues({ ...INPUT, attachments: { resume: false, coverLetter: false } });
    const plan = buildFillPlan(snap(healthyGh), greenhouseV1, noResume);
    expect(plan.audit.find((a) => a.canonical === "resume")).toMatchObject({ action: "flagged", reason: "no_resume_export" });
  });

  it("uses a select's Yes/No option value and flags unrecognized options", () => {
    const yesNo = f({ key: "f7", control: "select", label: "Do you require visa sponsorship?", options: [
      { key: "f7", label: "Select...", value: "" }, { key: "f7", label: "Yes", value: "1" }, { key: "f7", label: "No", value: "0" },
    ] });
    const plan = buildFillPlan(snap([...healthyGh, yesNo]), greenhouseV1, values);
    expect(plan.actions).toContainEqual({ kind: "selectOption", fieldKey: "f7", targetKey: "f7", optionValue: "0" });
    const odd = f({ key: "f8", control: "radio_group", required: true, label: "Will you require sponsorship?", options: [
      { key: "f9", label: "Maybe", value: "m" }, { key: "f10", label: "Later", value: "l" },
    ] });
    expect(buildFillPlan(snap([...healthyGh, odd]), greenhouseV1, values).audit.find((a) => a.key === "f8")).toMatchObject({
      action: "flagged", reason: "unrecognized_options",
    });
  });

  it("never puts a value into the audit", () => {
    const serialized = JSON.stringify([buildFillPlan(gh, greenhouseV1, values).audit, buildFillPlan(lv, leverV1, values).audit]);
    for (const secret of ["jane@example.com", "Jane", "Doe", "+49 30 1234", "linkedin.com/in/jane", "85000"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ai-career/browser test -- buildAutofillValues classifyField buildFillPlan`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/browser/src/values/buildAutofillValues.ts`:
```ts
import type { AutofillValues } from "../types";

export interface AutofillInput {
  profile: { fullName: string; email: string; phoneNumber: string | null; linkedinUrl: string | null; addressLine1: string | null };
  /** The active career goal's constraints, or null when there is none. */
  goal: {
    visaSponsorshipRequired: boolean | null;
    salaryTargetNormalized: string | null;
    salaryTargetCurrency: string | null;
    salaryTargetIsParsed: boolean;
  } | null;
  /** Whether a generated PDF exists (and was downloaded) for this job. */
  attachments: { resume: boolean; coverLetter: boolean };
}

const present = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/**
 * Design §4.3. Deterministic: every value comes from confirmed profile/goal data and carries its source label.
 * A missing value is simply absent -- buildFillPlan turns that into a skipped/flagged audit entry.
 */
export function buildAutofillValues(input: AutofillInput): AutofillValues {
  const values: AutofillValues = {};
  const text = (s: string | null, source: string) => (s === null ? undefined : { kind: "text" as const, text: s, source });

  const tokens = input.profile.fullName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) values.full_name = text(tokens.join(" "), "profile.fullName");
  if (tokens.length >= 2) {
    values.first_name = text(tokens.slice(0, -1).join(" "), "profile.fullName");
    values.last_name = text(tokens[tokens.length - 1], "profile.fullName");
  }
  values.email = text(present(input.profile.email), "profile.email");
  values.phone = text(present(input.profile.phoneNumber), "profile.phoneNumber");
  values.linkedin = text(present(input.profile.linkedinUrl), "profile.linkedinUrl");
  values.location = text(present(input.profile.addressLine1), "profile.addressLine1");

  if (input.attachments.resume) values.resume = { kind: "file", file: "resume", source: "generated_documents.resume" };
  if (input.attachments.coverLetter) values.cover_letter = { kind: "file", file: "cover_letter", source: "generated_documents.cover_letter" };

  const goal = input.goal;
  if (goal && goal.visaSponsorshipRequired !== null) {
    values.sponsorship = { kind: "boolean", value: goal.visaSponsorshipRequired, source: "goal.visaSponsorshipRequired" };
  }
  if (goal && goal.salaryTargetIsParsed && goal.salaryTargetNormalized !== null && present(goal.salaryTargetCurrency)) {
    const amount = Number(goal.salaryTargetNormalized);
    if (Number.isFinite(amount) && amount > 0) {
      values.salary_expectation = text(`${Math.round(amount)} ${goal.salaryTargetCurrency!.trim()}`, "goal.salaryTarget");
    }
  }

  for (const key of Object.keys(values) as (keyof AutofillValues)[]) if (values[key] === undefined) delete values[key];
  return values;
}
```

`packages/browser/src/plan/classifyField.ts`:
```ts
import type { Canonical, SnapshotField } from "../types";
import type { FieldMatcher, PortalAdapter } from "../adapters/types";

export interface Classification {
  canonical: Canonical;
  flagReason: string | null;
}

const EEO = /\b(?:gender|race|racial|ethnicity|hispanic|latin[oax]|veteran|disabilit(?:y|ies)|sexual orientation|pronouns?|transgender)\b/i;
const WORK_AUTHORIZATION =
  /\b(?:authori[sz]ed|authori[sz]ation|eligible|eligibility)\b[^?]*\bwork\b|\bright to work\b|\bwork permit\b|\bcitizen(?:ship)?\b|\bpermanent resident\b/i;
const SPONSORSHIP = /\b(?:require|need)\b[^?]*\bsponsor|\bsponsorship\b[^?]*\b(?:require|need)/i;
const SALARY = /\b(?:salary|compensation|pay)\b[^?]*\b(?:expect|desired|requirement)|\b(?:expected|desired)\s+(?:salary|compensation|pay)\b/i;

/** Order matters: the first match wins, so the never-filled categories are checked before fillable ones. */
const SHARED_LABEL_RULES: { canonical: Canonical; pattern: RegExp }[] = [
  { canonical: "eeo", pattern: EEO },
  { canonical: "work_authorization", pattern: WORK_AUTHORIZATION },
  { canonical: "sponsorship", pattern: SPONSORSHIP },
  { canonical: "salary_expectation", pattern: SALARY },
  { canonical: "linkedin", pattern: /linkedin/i },
  { canonical: "github", pattern: /github/i },
  { canonical: "website", pattern: /\b(?:portfolio|website|personal site|blog)\b/i },
];

const anyMatch = (patterns: RegExp[] | undefined, value: string | null): boolean =>
  value !== null && (patterns ?? []).some((p) => p.test(value));

const matches = (field: SnapshotField, m: FieldMatcher): boolean =>
  anyMatch(m.ids, field.id) || anyMatch(m.names, field.name) || anyMatch(m.labels, field.label);

/** Design §4.3/§4.4. Pure and deterministic; labels are untrusted page text and are only regex-tested here. */
export function classifyField(field: SnapshotField, adapter: PortalAdapter): Classification | null {
  for (const rule of adapter.standardFields) {
    if (matches(field, rule.match)) return { canonical: rule.canonical, flagReason: rule.flagReason ?? null };
  }
  if (field.label !== null) {
    for (const rule of SHARED_LABEL_RULES) if (rule.pattern.test(field.label)) return { canonical: rule.canonical, flagReason: null };
  }
  return null;
}
```

`packages/browser/src/plan/buildFillPlan.ts`:
```ts
import type {
  AutofillValue, AutofillValues, Canonical, FieldAuditEntry, FillAction, FillPlan, FormSnapshot, SnapshotControl, SnapshotField,
} from "../types";
import { isNeverFill } from "../types";
import type { PortalAdapter } from "../adapters/types";
import { classifyField } from "./classifyField";

const TEXT_CONTROLS = new Set<SnapshotControl>(["text", "email", "tel", "url", "number"]);
const YES = /^yes\b/i;
const NO = /^no\b/i;

function toAction(field: SnapshotField, value: AutofillValue): FillAction | { reason: string } {
  if (value.kind === "text") {
    return TEXT_CONTROLS.has(field.control)
      ? { kind: "fill", fieldKey: field.key, targetKey: field.key, text: value.text }
      : { reason: "unsupported_control" };
  }
  if (value.kind === "file") {
    return field.control === "file"
      ? { kind: "setInputFiles", fieldKey: field.key, targetKey: field.key, file: value.file }
      : { reason: "unsupported_control" };
  }
  if (field.control !== "radio_group" && field.control !== "select") return { reason: "unsupported_control" };
  const yes = field.options.filter((o) => YES.test(o.label.trim()));
  const no = field.options.filter((o) => NO.test(o.label.trim()));
  if (yes.length !== 1 || no.length !== 1) return { reason: "unrecognized_options" };
  const pick = value.value ? yes[0] : no[0];
  return field.control === "radio_group"
    ? { kind: "check", fieldKey: field.key, targetKey: pick.key }
    : { kind: "selectOption", fieldKey: field.key, targetKey: field.key, optionValue: pick.value };
}

/**
 * Design §4.4. Decides everything the worker will do to the page. A field is filled only when exactly one field
 * maps to its canonical, a value exists, and the control type fits. Everything else is audited: `flagged` when the
 * user must act (required, ambiguous, missing resume), `skipped` otherwise. Audit entries never hold values.
 */
export function buildFillPlan(snapshot: FormSnapshot, adapter: PortalAdapter, values: AutofillValues): FillPlan {
  const classified = snapshot.fields.map((field) => ({ field, cls: classifyField(field, adapter) }));
  const counts = new Map<Canonical, number>();
  for (const { cls } of classified) if (cls) counts.set(cls.canonical, (counts.get(cls.canonical) ?? 0) + 1);

  const missingForHealth = snapshot.formFound
    ? adapter.requiredCanonicals.filter((c) => counts.get(c) !== 1)
    : [...adapter.requiredCanonicals];
  const healthy = snapshot.formFound && missingForHealth.length === 0;

  const actions: FillAction[] = [];
  const audit: FieldAuditEntry[] = [];

  for (const { field, cls } of classified) {
    const canonical = cls?.canonical ?? null;
    const entry = (action: FieldAuditEntry["action"], reason: string | null, valueSource: string | null = null) =>
      audit.push({ key: field.key, label: field.label, required: field.required, canonical, action, reason, valueSource, verified: null });
    const notFilled = (reason: string) => entry(field.required ? "flagged" : "skipped", reason);

    if (!healthy) { entry("skipped", "health_check_failed"); continue; }
    if (!cls) { notFilled("unrecognized"); continue; }
    if (isNeverFill(cls.canonical)) { notFilled(cls.canonical === "eeo" ? "intentionally_not_filled" : "not_auto_filled"); continue; }
    if (cls.flagReason) { notFilled(cls.flagReason); continue; }
    if ((counts.get(cls.canonical) ?? 0) > 1) { entry("flagged", "ambiguous_match"); continue; }

    const value = values[cls.canonical];
    if (!value) {
      if (cls.canonical === "resume") entry("flagged", "no_resume_export");
      else notFilled("no_value");
      continue;
    }
    const action = toAction(field, value);
    if ("reason" in action) { notFilled(action.reason); continue; }
    actions.push(action);
    entry("filled", null, value.source);
  }

  return { healthy, missingForHealth: healthy ? [] : missingForHealth, actions, audit };
}
```

Append to `packages/browser/src/index.ts`:
```ts
export { buildAutofillValues, type AutofillInput } from "./values/buildAutofillValues";
export { classifyField, type Classification } from "./plan/classifyField";
export { buildFillPlan } from "./plan/buildFillPlan";
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `pnpm --filter @ai-career/browser test && pnpm --filter @ai-career/browser typecheck && pnpm --filter @ai-career/browser lint`
Expected: all PASS. If a Greenhouse/Lever filled-set assertion fails, print the plan's audit and check the classification against the fixture labels from Task 3 before changing either rules or expectations.

- [ ] **Step 5: Commit**

```bash
git add packages/browser
git commit -m "feat(browser): deterministic autofill values, field classification and fill plan with value-free audit"
```

---

### Task 5: Session DB operations

**Files:**
- Create: `packages/browser/src/sessions/support.ts`, `createSession.ts`, `transitions.ts`, `readSessions.ts`, `loadAutofillContext.ts`, `packages/browser/src/testing/db.ts`
- Modify: `packages/browser/src/testing/index.ts`, `packages/browser/src/index.ts`
- Test: `packages/browser/src/sessions/sessions.test.ts`

**Interfaces:**
- Consumes: `schema.automationSessions` (Task 1), `resolveAutofillTarget` (Task 2), `AutomationError` (Task 2).
- Produces (exported from `@ai-career/browser`):
  - `type SessionRow = typeof schema.automationSessions.$inferSelect`
  - `type AutofillSupport = { supported: true; portal: Portal; adapterVersion: string; formUrl: string } | { supported: false; reason: UnsupportedReason }`
  - `getAutofillSupport(tx: DbClient, jobId: string): Promise<AutofillSupport>` (call inside `withUserContext`)
  - `createSession(db, userId, jobId): Promise<SessionRow>` — throws `AutomationError` `job_not_found` | `profile_missing` | `unsupported` (detail = reason) | `session_active`.
  - `transitionSession(db, userId, sessionId, from: readonly AutomationStatus[], to: AutomationStatus, patch?: TransitionPatch, now?: Date): Promise<SessionRow | null>`; `type TransitionPatch = { fieldAudit?: FieldAuditEntry[]; errorCode?: string | null; resumeDocumentId?: string | null; coverLetterDocumentId?: string | null; startedAt?: Date; submissionDetectedAt?: Date }`
  - `failSession(db, userId, sessionId, errorCode): Promise<SessionRow | null>` (any active → failed)
  - `requestCancel(db, userId, sessionId, now?): Promise<SessionRow>` — `not_found` | `not_cancellable`.
  - `isCancelRequested(db, userId, sessionId): Promise<boolean>`
  - `sweepInterruptedSessions(db, userId, now?): Promise<number>` (launching/filling/awaiting_user → failed `worker_restart`)
  - `getSession(db, userId, sessionId): Promise<SessionRow | null>`
  - `getJobAutofillOverview(db, userId, jobId): Promise<JobAutofillOverview | null>` (null = job not found); `type JobAutofillOverview = { support: AutofillSupport; resumeAvailable: boolean; applicationId: string | null; sessions: SessionRow[] }` (newest first, at most 10)
  - `loadAutofillContext(db, userId, sessionId): Promise<AutofillContext>`; `type AutofillContext = { session: SessionRow; profile: AutofillInput["profile"]; goal: AutofillInput["goal"]; resumeDocument: StoredDocumentRef | null; coverLetterDocument: StoredDocumentRef | null }`; `type StoredDocumentRef = { id: string; objectKey: string }`
  - From `@ai-career/browser/testing`: `openTestDb()`, `wipeUser(adminSql, userId)`, `seedAutofillJob(adminSql, userId, opts?)`, `insertSessionRow(adminSql, userId, jobId, opts?)`, `type TestDb`, `type SeededAutofillJob = { jobId: string; resumeDocumentId: string | null; coverLetterDocumentId: string | null }`.

- [ ] **Step 1: Write the test helpers**

`packages/browser/src/testing/db.ts`:
```ts
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";

// packages/browser/src/testing -> packages/db/migrations
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

/** Scoped to one user: other suites share the database concurrently. Sessions/documents/postings cascade from jobs. */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM applications WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM candidate_profiles WHERE user_id = ${userId}`;
}

export interface SeedAutofillOptions {
  sourceKind?: "greenhouse" | "lever" | "upload";
  slug?: string;
  externalId?: string;
  /** Default true. */
  withProfile?: boolean;
  /** Default { visaSponsorshipRequired: false, salary target 85000 EUR parsed }. null = no active goal. */
  goal?: { visaSponsorshipRequired: boolean | null } | null;
  /** Default true: a resume PDF generated_documents row (object key is fake; tests that download must upload it). */
  withResume?: boolean;
  withCoverLetter?: boolean;
}

export interface SeededAutofillJob {
  jobId: string;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
}

export async function seedAutofillJob(adminSql: postgres.Sql, userId: string, opts: SeedAutofillOptions = {}): Promise<SeededAutofillJob> {
  const kind = opts.sourceKind ?? "greenhouse";
  if (opts.withProfile ?? true) {
    await adminSql`
      INSERT INTO candidate_profiles (user_id, full_name, email, phone_number, linkedin_url, address_line1)
      VALUES (${userId}, 'Jane Doe', 'jane@example.com', '+49 30 1234', 'https://linkedin.com/in/jane', 'Berlin')
      ON CONFLICT (user_id) DO NOTHING`;
  }
  const goal = opts.goal === undefined ? { visaSponsorshipRequired: false } : opts.goal;
  if (goal) {
    const [g] = await adminSql`
      INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
      VALUES (${userId}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
    await adminSql`
      INSERT INTO career_goal_constraints (user_id, career_goal_id, visa_sponsorship_required,
                                           salary_target_normalized, salary_target_currency, salary_target_is_parsed)
      VALUES (${userId}, ${g.id}, ${goal.visaSponsorshipRequired}, 85000, 'EUR', true)`;
  }
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${userId}, 'Acme', 'acme', 'Data Engineer', 'data engineer', 'dh', now(), now()) RETURNING id`;
  const config = kind === "upload" ? {} : { slug: opts.slug ?? "acme" };
  const [source] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config, enabled)
    VALUES (${userId}, ${kind}, 'Acme', ${JSON.stringify(config)}::jsonb, false) RETURNING id`;
  await adminSql`
    INSERT INTO job_postings (user_id, job_id, source_id, external_id, url, fingerprint, content_hash, normalized, status, first_seen_at, last_seen_at)
    VALUES (${userId}, ${job.id}, ${source.id}, ${opts.externalId ?? "1234567"}, null, 'fp', 'h', '{}'::jsonb, 'open', now(), now())`;
  const doc = async (docKind: "resume" | "cover_letter") => {
    const [row] = await adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
      VALUES (${userId}, ${job.id}, ${docKind}, 'pdf', ${`${userId}/${docKind}-${job.id}.pdf`}, 10, ${"h-" + docKind}, 'r1', ${docKind + ".pdf"})
      RETURNING id`;
    return row.id as string;
  };
  return {
    jobId: job.id as string,
    resumeDocumentId: (opts.withResume ?? true) ? await doc("resume") : null,
    coverLetterDocumentId: opts.withCoverLetter ? await doc("cover_letter") : null,
  };
}

export async function insertSessionRow(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  opts: { status?: string; formUrl?: string; portal?: "greenhouse" | "lever"; cancelRequested?: boolean } = {}
): Promise<string> {
  const status = opts.status ?? "queued";
  const terminal = ["submission_detected", "abandoned", "needs_manual", "failed"].includes(status);
  const portal = opts.portal ?? "greenhouse";
  const [row] = await adminSql`
    INSERT INTO automation_sessions (user_id, job_id, portal, adapter_version, form_url, status, ended_at, cancel_requested_at)
    VALUES (${userId}, ${jobId}, ${portal}, ${portal + "-v1"}, ${opts.formUrl ?? "https://job-boards.greenhouse.io/acme/jobs/1234567"},
            ${status}, ${terminal ? new Date().toISOString() : null}::timestamptz,
            ${opts.cancelRequested ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  return row.id as string;
}
```

Replace `packages/browser/src/testing/index.ts` with:
```ts
export { snapshotFromHtml, readFixture } from "./snapshotFromHtml";
export {
  openTestDb, wipeUser, seedAutofillJob, insertSessionRow, type TestDb, type SeedAutofillOptions, type SeededAutofillJob,
} from "./db";
```

- [ ] **Step 2: Write the failing test**

`packages/browser/src/sessions/sessions.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { openTestDb, wipeUser, seedAutofillJob, insertSessionRow, type TestDb } from "../testing";
import {
  createSession, transitionSession, failSession, requestCancel, isCancelRequested, sweepInterruptedSessions,
  getSession, getJobAutofillOverview, loadAutofillContext,
} from "../index";
import { AutomationError } from "../errors";

const USER = "00000000-0000-0000-0000-0000000008a3";
const OTHER = "00000000-0000-0000-0000-0000000008a4";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
  await t.close();
});

const errorClass = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof AutomationError ? `${e.errorClass}${e.detail ? `:${e.detail}` : ""}` : String(e);
  }
};

describe("createSession", () => {
  it("creates a queued session with the built form URL", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { sourceKind: "lever", slug: "acme", externalId: "abc-1" });
    const row = await createSession(t.db, USER, jobId);
    expect(row).toMatchObject({ jobId, status: "queued", portal: "lever", adapterVersion: "lever-v1", formUrl: "https://jobs.lever.co/acme/abc-1/apply" });
  });

  it("rejects an unknown job, a missing profile, an unsupported job and a second active session", async () => {
    expect(await errorClass(createSession(t.db, USER, "11111111-1111-4111-8111-111111111111"))).toBe("job_not_found");
    const noProfile = await seedAutofillJob(t.adminSql, USER, { withProfile: false });
    expect(await errorClass(createSession(t.db, USER, noProfile.jobId))).toBe("profile_missing");
    await wipeUser(t.adminSql, USER);
    const upload = await seedAutofillJob(t.adminSql, USER, { sourceKind: "upload" });
    expect(await errorClass(createSession(t.db, USER, upload.jobId))).toBe("unsupported:no_supported_posting");
    await wipeUser(t.adminSql, USER);
    const ok = await seedAutofillJob(t.adminSql, USER);
    await createSession(t.db, USER, ok.jobId);
    expect(await errorClass(createSession(t.db, USER, ok.jobId))).toBe("session_active");
  });

  it("does not see another user's job", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, OTHER);
    await seedAutofillJob(t.adminSql, USER);
    expect(await errorClass(createSession(t.db, USER, jobId))).toBe("job_not_found");
  });
});

describe("transitions", () => {
  it("moves only from the expected statuses and stamps ended_at on terminal ones", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId);
    expect(await transitionSession(t.db, USER, id, ["filling"], "awaiting_user")).toBeNull();
    const launching = await transitionSession(t.db, USER, id, ["queued"], "launching", { startedAt: new Date() });
    expect(launching).toMatchObject({ status: "launching", endedAt: null });
    expect(launching!.startedAt).not.toBeNull();
    const audit = [{ key: "f0", label: "Email", required: true, canonical: "email" as const, action: "filled" as const, reason: null, valueSource: "profile.email", verified: true }];
    const done = await transitionSession(t.db, USER, id, ["launching"], "needs_manual", { fieldAudit: audit, errorCode: "health_check_failed" });
    expect(done).toMatchObject({ status: "needs_manual", errorCode: "health_check_failed", fieldAudit: audit });
    expect(done!.endedAt).not.toBeNull();
    expect(await failSession(t.db, USER, id, "x")).toBeNull(); // already terminal
  });

  it("cancels a queued session immediately and flags an active one", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const queued = await insertSessionRow(t.adminSql, USER, jobId);
    expect(await requestCancel(t.db, USER, queued)).toMatchObject({ status: "abandoned", errorCode: "cancelled" });
    expect(await errorClass(requestCancel(t.db, USER, queued))).toBe("not_cancellable");
    const active = await insertSessionRow(t.adminSql, USER, jobId, { status: "awaiting_user" });
    expect(await isCancelRequested(t.db, USER, active)).toBe(false);
    const flagged = await requestCancel(t.db, USER, active);
    expect(flagged.status).toBe("awaiting_user");
    expect(await isCancelRequested(t.db, USER, active)).toBe(true);
    expect(await errorClass(requestCancel(t.db, USER, "11111111-1111-4111-8111-111111111111"))).toBe("not_found");
  });

  it("sweeps launching/filling/awaiting_user to failed but leaves queued alone", async () => {
    const a = await seedAutofillJob(t.adminSql, USER);
    const awaiting = await insertSessionRow(t.adminSql, USER, a.jobId, { status: "awaiting_user" });
    expect(await sweepInterruptedSessions(t.db, USER)).toBe(1);
    expect(await getSession(t.db, USER, awaiting)).toMatchObject({ status: "failed", errorCode: "worker_restart" });
    const queued = await insertSessionRow(t.adminSql, USER, a.jobId);
    expect(await sweepInterruptedSessions(t.db, USER)).toBe(0);
    expect((await getSession(t.db, USER, queued))!.status).toBe("queued");
  });
});

describe("reads", () => {
  it("summarizes a job's autofill state", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    await insertSessionRow(t.adminSql, USER, jobId, { status: "failed" });
    const overview = await getJobAutofillOverview(t.db, USER, jobId);
    expect(overview).toMatchObject({
      support: { supported: true, portal: "greenhouse", formUrl: "https://job-boards.greenhouse.io/acme/jobs/1234567" },
      resumeAvailable: true,
      applicationId: null,
    });
    expect(overview!.sessions).toHaveLength(1);
    expect(await getJobAutofillOverview(t.db, USER, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("loads the autofill context: profile, active goal constraints and the newest PDFs", async () => {
    const { jobId, resumeDocumentId, coverLetterDocumentId } = await seedAutofillJob(t.adminSql, USER, { withCoverLetter: true });
    const id = await insertSessionRow(t.adminSql, USER, jobId);
    const ctx = await loadAutofillContext(t.db, USER, id);
    expect(ctx.profile).toEqual({
      fullName: "Jane Doe", email: "jane@example.com", phoneNumber: "+49 30 1234", linkedinUrl: "https://linkedin.com/in/jane", addressLine1: "Berlin",
    });
    expect(ctx.goal).toMatchObject({ visaSponsorshipRequired: false, salaryTargetCurrency: "EUR", salaryTargetIsParsed: true });
    expect(Number(ctx.goal!.salaryTargetNormalized)).toBe(85000);
    expect(ctx.resumeDocument?.id).toBe(resumeDocumentId);
    expect(ctx.coverLetterDocument?.id).toBe(coverLetterDocumentId);
  });

  it("loads a null goal when there is no active goal", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { goal: null, withResume: false });
    const ctx = await loadAutofillContext(t.db, USER, await insertSessionRow(t.adminSql, USER, jobId));
    expect(ctx.goal).toBeNull();
    expect(ctx.resumeDocument).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ai-career/browser test -- sessions`
Expected: FAIL — `createSession` etc. not exported.

- [ ] **Step 4: Implement**

`packages/browser/src/sessions/support.ts`:
```ts
import { eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { resolveAutofillTarget, type UnsupportedReason } from "../adapters/resolveAutofillTarget";
import type { Portal } from "../types";

const { jobPostings, jobSources } = schema;

export type AutofillSupport =
  | { supported: true; portal: Portal; adapterVersion: string; formUrl: string }
  | { supported: false; reason: UnsupportedReason };

/** Call inside withUserContext. */
export async function getAutofillSupport(tx: DbClient, jobId: string): Promise<AutofillSupport> {
  const rows = await tx
    .select({ kind: jobSources.kind, config: jobSources.config, externalId: jobPostings.externalId, status: jobPostings.status, lastSeenAt: jobPostings.lastSeenAt })
    .from(jobPostings)
    .innerJoin(jobSources, eq(jobSources.id, jobPostings.sourceId))
    .where(eq(jobPostings.jobId, jobId));
  const target = resolveAutofillTarget(
    rows.map((r) => ({ sourceKind: r.kind, slug: r.config.slug ?? null, externalId: r.externalId, status: r.status, lastSeenAt: r.lastSeenAt }))
  );
  return target.supported
    ? { supported: true, portal: target.adapter.portal, adapterVersion: target.adapter.version, formUrl: target.formUrl }
    : target;
}
```

`packages/browser/src/sessions/createSession.ts`:
```ts
import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AutomationError } from "../errors";
import { getAutofillSupport } from "./support";

const { jobs, candidateProfiles, automationSessions } = schema;

export type SessionRow = typeof automationSessions.$inferSelect;

/** Postgres unique_violation (23505), bare or wrapped as `cause` by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Design §6 POST. The partial unique index automation_sessions_one_active_per_user is the concurrency backstop
 * for "one browser window at a time" -> session_active.
 */
export async function createSession(db: DbClient, userId: string, jobId: string): Promise<SessionRow> {
  try {
    return await withUserContext(db, userId, async (tx) => {
      const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!job) throw new AutomationError("job_not_found");
      const [profile] = await tx.select({ id: candidateProfiles.id }).from(candidateProfiles).limit(1);
      if (!profile) throw new AutomationError("profile_missing");
      const support = await getAutofillSupport(tx, jobId);
      if (!support.supported) throw new AutomationError("unsupported", support.reason);
      const [row] = await tx
        .insert(automationSessions)
        .values({ jobId, portal: support.portal, adapterVersion: support.adapterVersion, formUrl: support.formUrl, status: "queued" })
        .returning();
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AutomationError("session_active");
    throw error;
  }
}
```

`packages/browser/src/sessions/transitions.ts`:
```ts
import { and, eq, inArray } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AutomationError } from "../errors";
import { ACTIVE_STATUSES, isActiveStatus, isTerminalStatus, type AutomationStatus, type FieldAuditEntry } from "../types";
import type { SessionRow } from "./createSession";

const { automationSessions } = schema;

export interface TransitionPatch {
  fieldAudit?: FieldAuditEntry[];
  errorCode?: string | null;
  resumeDocumentId?: string | null;
  coverLetterDocumentId?: string | null;
  startedAt?: Date;
  submissionDetectedAt?: Date;
}

/**
 * A conditional UPDATE: only applies while the row is in one of `from`. Returns null when it was not (cancelled,
 * swept, or claimed elsewhere), which callers treat as "stop". ended_at follows the target status (CHECK).
 */
export async function transitionSession(
  db: DbClient,
  userId: string,
  sessionId: string,
  from: readonly AutomationStatus[],
  to: AutomationStatus,
  patch: TransitionPatch = {},
  now: Date = new Date()
): Promise<SessionRow | null> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx
      .update(automationSessions)
      .set({ ...patch, status: to, updatedAt: now, endedAt: isTerminalStatus(to) ? now : null })
      .where(and(eq(automationSessions.id, sessionId), inArray(automationSessions.status, [...from])))
      .returning();
    return row ?? null;
  });
}

export const failSession = (db: DbClient, userId: string, sessionId: string, errorCode: string) =>
  transitionSession(db, userId, sessionId, ACTIVE_STATUSES, "failed", { errorCode });

/**
 * Design §6 cancel. FOR UPDATE serializes with the worker's queued->launching claim: a queued row is abandoned
 * here directly; a row the worker already owns gets cancel_requested_at, which the worker polls.
 */
export async function requestCancel(db: DbClient, userId: string, sessionId: string, now: Date = new Date()): Promise<SessionRow> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx.select().from(automationSessions).where(eq(automationSessions.id, sessionId)).for("update");
    if (!row) throw new AutomationError("not_found");
    if (!isActiveStatus(row.status)) throw new AutomationError("not_cancellable");
    const patch =
      row.status === "queued"
        ? { status: "abandoned" as const, endedAt: now, errorCode: "cancelled", cancelRequestedAt: now, updatedAt: now }
        : { cancelRequestedAt: now, updatedAt: now };
    const [updated] = await tx.update(automationSessions).set(patch).where(eq(automationSessions.id, sessionId)).returning();
    return updated;
  });
}

export async function isCancelRequested(db: DbClient, userId: string, sessionId: string): Promise<boolean> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx
      .select({ at: automationSessions.cancelRequestedAt })
      .from(automationSessions)
      .where(eq(automationSessions.id, sessionId));
    return row?.at != null;
  });
}

/** Spec §11.5: run on worker startup. Queued sessions are left for the worker to pick up. */
export async function sweepInterruptedSessions(db: DbClient, userId: string, now: Date = new Date()): Promise<number> {
  return withUserContext(db, userId, async (tx) => {
    const rows = await tx
      .update(automationSessions)
      .set({ status: "failed", errorCode: "worker_restart", endedAt: now, updatedAt: now })
      .where(inArray(automationSessions.status, ["launching", "filling", "awaiting_user"]))
      .returning({ id: automationSessions.id });
    return rows.length;
  });
}
```

`packages/browser/src/sessions/readSessions.ts`:
```ts
import { and, desc, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { getAutofillSupport, type AutofillSupport } from "./support";
import type { SessionRow } from "./createSession";

const { jobs, automationSessions, generatedDocuments, applications } = schema;

export interface JobAutofillOverview {
  support: AutofillSupport;
  resumeAvailable: boolean;
  applicationId: string | null;
  sessions: SessionRow[];
}

export async function getSession(db: DbClient, userId: string, sessionId: string): Promise<SessionRow | null> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx.select().from(automationSessions).where(eq(automationSessions.id, sessionId));
    return row ?? null;
  });
}

/** Everything AutofillPanel needs in one request; null when the job does not exist (or is another user's). */
export async function getJobAutofillOverview(db: DbClient, userId: string, jobId: string): Promise<JobAutofillOverview | null> {
  return withUserContext(db, userId, async (tx) => {
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
    if (!job) return null;
    const support = await getAutofillSupport(tx, jobId);
    const [resume] = await tx
      .select({ id: generatedDocuments.id })
      .from(generatedDocuments)
      .where(and(eq(generatedDocuments.jobId, jobId), eq(generatedDocuments.kind, "resume"), eq(generatedDocuments.format, "pdf")))
      .limit(1);
    const [application] = await tx.select({ id: applications.id }).from(applications).where(eq(applications.jobId, jobId)).limit(1);
    const sessions = await tx
      .select()
      .from(automationSessions)
      .where(eq(automationSessions.jobId, jobId))
      .orderBy(desc(automationSessions.createdAt))
      .limit(10);
    return { support, resumeAvailable: Boolean(resume), applicationId: application?.id ?? null, sessions };
  });
}
```

`packages/browser/src/sessions/loadAutofillContext.ts`:
```ts
import { and, desc, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AutomationError } from "../errors";
import type { AutofillInput } from "../values/buildAutofillValues";
import type { SessionRow } from "./createSession";

const { automationSessions, candidateProfiles, careerGoals, careerGoalConstraints, generatedDocuments } = schema;

export interface StoredDocumentRef {
  id: string;
  objectKey: string;
}

export interface AutofillContext {
  session: SessionRow;
  profile: AutofillInput["profile"];
  goal: AutofillInput["goal"];
  resumeDocument: StoredDocumentRef | null;
  coverLetterDocument: StoredDocumentRef | null;
}

/** Everything the worker needs, read in one transaction. The newest PDF export of each kind for the job is attached. */
export async function loadAutofillContext(db: DbClient, userId: string, sessionId: string): Promise<AutofillContext> {
  return withUserContext(db, userId, async (tx) => {
    const [session] = await tx.select().from(automationSessions).where(eq(automationSessions.id, sessionId));
    if (!session) throw new AutomationError("not_found");
    const [profile] = await tx
      .select({
        fullName: candidateProfiles.fullName, email: candidateProfiles.email, phoneNumber: candidateProfiles.phoneNumber,
        linkedinUrl: candidateProfiles.linkedinUrl, addressLine1: candidateProfiles.addressLine1,
      })
      .from(candidateProfiles)
      .limit(1);
    if (!profile) throw new AutomationError("profile_missing");
    const [goal] = await tx
      .select({
        visaSponsorshipRequired: careerGoalConstraints.visaSponsorshipRequired,
        salaryTargetNormalized: careerGoalConstraints.salaryTargetNormalized,
        salaryTargetCurrency: careerGoalConstraints.salaryTargetCurrency,
        salaryTargetIsParsed: careerGoalConstraints.salaryTargetIsParsed,
      })
      .from(careerGoalConstraints)
      .innerJoin(careerGoals, eq(careerGoals.id, careerGoalConstraints.careerGoalId))
      .where(eq(careerGoals.isActive, true))
      .limit(1);
    const newestPdf = async (kind: "resume" | "cover_letter") => {
      const [doc] = await tx
        .select({ id: generatedDocuments.id, objectKey: generatedDocuments.objectKey })
        .from(generatedDocuments)
        .where(and(eq(generatedDocuments.jobId, session.jobId), eq(generatedDocuments.kind, kind), eq(generatedDocuments.format, "pdf")))
        .orderBy(desc(generatedDocuments.createdAt))
        .limit(1);
      return doc ?? null;
    };
    return {
      session,
      profile,
      goal: goal ?? null,
      resumeDocument: await newestPdf("resume"),
      coverLetterDocument: await newestPdf("cover_letter"),
    };
  });
}
```

Append to `packages/browser/src/index.ts`:
```ts
export { getAutofillSupport, type AutofillSupport } from "./sessions/support";
export { createSession, type SessionRow } from "./sessions/createSession";
export {
  transitionSession, failSession, requestCancel, isCancelRequested, sweepInterruptedSessions, type TransitionPatch,
} from "./sessions/transitions";
export { getSession, getJobAutofillOverview, type JobAutofillOverview } from "./sessions/readSessions";
export { loadAutofillContext, type AutofillContext, type StoredDocumentRef } from "./sessions/loadAutofillContext";
```

- [ ] **Step 5: Run the whole package suite, typecheck and lint**

Run: `pnpm --filter @ai-career/browser test && pnpm --filter @ai-career/browser typecheck && pnpm --filter @ai-career/browser lint`
Expected: all PASS. Check that `grep -rn "playwright\|bullmq\|ioredis" packages/browser/src` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/browser
git commit -m "feat(browser): automation session create/transition/cancel/sweep/read and autofill context loading"
```

---
### Task 6: Browser worker scaffold, env vars, guarded action layer and the no-click guard

**Files:**
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`
- Create: `services/browser-worker/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
- Create: `services/browser-worker/src/actions.ts`, `src/snapshot.ts`, `src/browser.ts`
- Test: `services/browser-worker/src/actions.test.ts`, `services/browser-worker/src/noClick.test.ts`

**Interfaces:**
- Consumes: `FillAction`, `FormSnapshot`, `PortalAdapter`, `EXTRACT_SNAPSHOT_SOURCE` (Tasks 2–3).
- Produces:
  - Env: `BROWSER_EXECUTABLE_PATH?: string`, `BROWSER_HEADLESS: boolean` (default false), `BROWSER_SESSION_TIMEOUT_MIN: number` (default 30).
  - `actions.ts`: `type AttachmentPaths = Partial<Record<"resume" | "cover_letter", string>>`, `class GuardViolation`, `performAction(page, action, files): Promise<void>`, `verifyAction(page, action): Promise<boolean>`.
  - `snapshot.ts`: `takeSnapshot(page, adapter): Promise<FormSnapshot>`, `readPageText(page): Promise<string>`.
  - `browser.ts`: `type BrowserOptions = { headless: boolean; executablePath?: string }`, `type BrowserHandle = { context; page; rootDir; isClosed(): boolean; close(): Promise<void> }`, `launchBrowser(opts: BrowserOptions & { rootDir: string }): Promise<BrowserHandle>`, `class ReleasedWindows { release(handle, ms): void; closeAll(): Promise<void>; get size(): number }`.

- [ ] **Step 1: Add the env vars (test first)**

Append inside `describe("loadEnv", ...)` in `packages/config/src/env.test.ts`:
```ts
  it("parses the Phase 8 browser settings with safe defaults", () => {
    const env = loadEnv({ ...validSource });
    expect(env.BROWSER_HEADLESS).toBe(false);
    expect(env.BROWSER_SESSION_TIMEOUT_MIN).toBe(30);
    expect(env.BROWSER_EXECUTABLE_PATH).toBeUndefined();
    const custom = loadEnv({ ...validSource, BROWSER_HEADLESS: "true", BROWSER_SESSION_TIMEOUT_MIN: "5", BROWSER_EXECUTABLE_PATH: "/opt/chrome" });
    expect(custom).toMatchObject({ BROWSER_HEADLESS: true, BROWSER_SESSION_TIMEOUT_MIN: 5, BROWSER_EXECUTABLE_PATH: "/opt/chrome" });
    expect(() => loadEnv({ ...validSource, BROWSER_HEADLESS: "yes" })).toThrow(/BROWSER_HEADLESS/);
    expect(() => loadEnv({ ...validSource, BROWSER_SESSION_TIMEOUT_MIN: "0" })).toThrow(/BROWSER_SESSION_TIMEOUT_MIN/);
  });
```
Run: `pnpm --filter @ai-career/config test` — Expected: FAIL (properties undefined / no throw).

Add to the schema object in `packages/config/src/env.ts`, after `RETENTION_DAYS`:
```ts
    // Phase 8 browser automation (services/browser-worker only). Chrome is found via Playwright's
    // channel "chrome" unless an explicit executable path is given. Headless is for tests: the whole
    // point of a session is a visible window the user finishes and submits.
    BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
    BROWSER_HEADLESS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    BROWSER_SESSION_TIMEOUT_MIN: z.coerce.number().int().min(1).max(240).default(30),
```
Run: `pnpm --filter @ai-career/config test` — Expected: PASS.

- [ ] **Step 2: Scaffold `services/browser-worker`**

`services/browser-worker/package.json`:
```json
{
  "name": "@ai-career/browser-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "dotenv -e ../../.env -- tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/browser": "workspace:*",
    "@ai-career/config": "workspace:*",
    "@ai-career/db": "workspace:*",
    "@ai-career/storage": "workspace:*",
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.0",
    "minio": "^8.0.2",
    "playwright-core": "^1.63.0",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "dotenv-cli": "^7.4.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```
Copy `tsconfig.json` and `eslint.config.mjs` from `services/maintenance-worker/`. `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Chrome + the shared test database: run files one at a time, and allow for browser start-up.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```
Run `pnpm install`. There is deliberately no `dev` script and no Dockerfile: the worker opens a visible window on the user's desktop (design §5).

- [ ] **Step 3: Write the failing guard tests**

`services/browser-worker/src/noClick.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [/\.click\(/, /\.dblclick\(/, /\.tap\(/, /\.press\(/, /\.submit\(/, /keyboard/, /requestSubmit/, /dispatchEvent/];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "testing" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

/** Design §5: stop-before-submit is structural. The worker has no way to click, press keys or submit. */
describe("browser-worker source", () => {
  it("contains no click, key-press or submit call", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, i) =>
        FORBIDDEN.filter((p) => p.test(line)).map((p) => `${path.relative(SRC, file)}:${i + 1} ${p}`)
      )
    );
    expect(hits).toEqual([]);
  });
});
```

`services/browser-worker/src/actions.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { greenhouseV1, type FillAction } from "@ai-career/browser";
import { launchBrowser, type BrowserHandle } from "./browser";
import { performAction, verifyAction, GuardViolation } from "./actions";
import { takeSnapshot } from "./snapshot";

const HTML = `<!doctype html><html><body><form id="application-form">
  <label for="first_name">First Name*</label><input id="first_name" type="text">
  <select id="pick"><option value="">Select</option><option value="1">Yes</option><option value="0">No</option></select>
  <label><input type="radio" name="sp" value="Yes">Yes</label><label><input type="radio" name="sp" value="No">No</label>
  <input id="resume" type="file">
  <button id="go" type="submit">Submit</button><a id="link" href="#">Link</a><input id="sub" type="submit" value="Send">
</form></body></html>`;

let root: string;
let handle: BrowserHandle;
let pdf: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cp-actions-test-"));
  pdf = path.join(root, "resume.pdf");
  await writeFile(pdf, "%PDF-1.4 test");
  handle = await launchBrowser({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, rootDir: path.join(root, "session") });
  await handle.page.setContent(HTML);
  await takeSnapshot(handle.page, greenhouseV1); // stamps data-cp-key: f0 text, f1 select, g2 radio group (f3, f4), f5 file
});
afterAll(async () => {
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

const stamp = (selector: string, key: string) =>
  handle.page.evaluate(`document.querySelector(${JSON.stringify(selector)}).setAttribute("data-cp-key", ${JSON.stringify(key)})`);

describe("guarded actions in real Chrome", () => {
  it("fills, selects, checks and attaches, and verifies each", async () => {
    const actions: FillAction[] = [
      { kind: "fill", fieldKey: "f0", targetKey: "f0", text: "Jane" },
      { kind: "selectOption", fieldKey: "f1", targetKey: "f1", optionValue: "0" },
      { kind: "check", fieldKey: "g2", targetKey: "f4" },
      { kind: "setInputFiles", fieldKey: "f5", targetKey: "f5", file: "resume" },
    ];
    for (const action of actions) {
      await performAction(handle.page, action, { resume: pdf });
      expect(await verifyAction(handle.page, action)).toBe(true);
    }
    expect(await handle.page.inputValue("#first_name")).toBe("Jane");
  });

  it("refuses to act on buttons, links and submit inputs", async () => {
    await stamp("#go", "f90");
    await stamp("#link", "f91");
    await stamp("#sub", "f92");
    for (const key of ["f90", "f91", "f92"]) {
      await expect(performAction(handle.page, { kind: "fill", fieldKey: key, targetKey: key, text: "x" }, {})).rejects.toBeInstanceOf(GuardViolation);
      await expect(performAction(handle.page, { kind: "check", fieldKey: key, targetKey: key }, {})).rejects.toBeInstanceOf(GuardViolation);
    }
  });

  it("refuses a mismatched control kind and malformed keys", async () => {
    await expect(performAction(handle.page, { kind: "check", fieldKey: "f0", targetKey: "f0" }, {})).rejects.toBeInstanceOf(GuardViolation);
    await expect(performAction(handle.page, { kind: "fill", fieldKey: "x", targetKey: '"] , button[id="go' }, {})).rejects.toBeInstanceOf(GuardViolation);
  });

  it("reports a failed verification as false rather than throwing", async () => {
    expect(await verifyAction(handle.page, { kind: "fill", fieldKey: "f0", targetKey: "f0", text: "Someone else" })).toBe(false);
    expect(await verifyAction(handle.page, { kind: "fill", fieldKey: "f999", targetKey: "f999", text: "x" })).toBe(false);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @ai-career/browser-worker test`
Expected: FAIL — `./browser`, `./actions`, `./snapshot` not found; the noClick test fails with "expected 0 to be greater than 0" (no source files yet).

- [ ] **Step 5: Implement**

`services/browser-worker/src/actions.ts`:
```ts
import type { Locator, Page } from "playwright-core";
import type { FillAction } from "@ai-career/browser";

export type AttachmentPaths = Partial<Record<"resume" | "cover_letter", string>>;

const ACTION_TIMEOUT_MS = 5_000;
const KEY = /^f\d+$/;
const FORBIDDEN_INPUT_TYPES = new Set(["submit", "button", "image", "reset"]);
const NON_TEXT_INPUT_TYPES = new Set(["radio", "checkbox", "file", "hidden", "submit", "button", "image", "reset"]);

/** Thrown when an action targets anything but the expected kind of form control. Carries no page content. */
export class GuardViolation extends Error {
  constructor() {
    super("guard_violation");
    this.name = "GuardViolation";
  }
}

const byKey = (page: Page, key: string): Locator => {
  if (!KEY.test(key)) throw new GuardViolation();
  return page.locator(`[data-cp-key="${key}"]`);
};

type Allowed = "text" | "select" | "choice" | "file";

/**
 * The stop-before-submit guard (design §5, DECISIONS D130). Every mutation goes through here: the element must be
 * the expected control kind, and is never a button, link or submit/image/reset input. `check` (which Playwright
 * performs as a click on the input itself) is therefore only ever applied to a radio or checkbox input.
 */
async function assertTarget(loc: Locator, allowed: Allowed): Promise<void> {
  const { tag, type } = await loc.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") ?? "text").toLowerCase() }));
  if (tag === "button" || tag === "a" || (tag === "input" && FORBIDDEN_INPUT_TYPES.has(type))) throw new GuardViolation();
  const ok =
    allowed === "select" ? tag === "select"
    : allowed === "choice" ? tag === "input" && (type === "radio" || type === "checkbox")
    : allowed === "file" ? tag === "input" && type === "file"
    : tag === "textarea" || (tag === "input" && !NON_TEXT_INPUT_TYPES.has(type));
  if (!ok) throw new GuardViolation();
}

export async function performAction(page: Page, action: FillAction, files: AttachmentPaths): Promise<void> {
  const loc = byKey(page, action.targetKey);
  switch (action.kind) {
    case "fill":
      await assertTarget(loc, "text");
      await loc.fill(action.text, { timeout: ACTION_TIMEOUT_MS });
      return;
    case "selectOption":
      await assertTarget(loc, "select");
      await loc.selectOption({ value: action.optionValue }, { timeout: ACTION_TIMEOUT_MS });
      return;
    case "check":
      await assertTarget(loc, "choice");
      await loc.check({ timeout: ACTION_TIMEOUT_MS });
      return;
    case "setInputFiles": {
      await assertTarget(loc, "file");
      const file = files[action.file];
      if (!file) throw new Error("attachment_missing");
      await loc.setInputFiles(file, { timeout: ACTION_TIMEOUT_MS });
      return;
    }
  }
}

/** Reads the control back. Any error (element gone, detached) counts as not verified. */
export async function verifyAction(page: Page, action: FillAction): Promise<boolean> {
  try {
    const loc = byKey(page, action.targetKey);
    switch (action.kind) {
      case "fill":
        return (await loc.inputValue({ timeout: ACTION_TIMEOUT_MS })) === action.text;
      case "selectOption":
        return (await loc.inputValue({ timeout: ACTION_TIMEOUT_MS })) === action.optionValue;
      case "check":
        return await loc.isChecked({ timeout: ACTION_TIMEOUT_MS });
      case "setInputFiles":
        return (await loc.evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)) > 0;
    }
  } catch {
    return false;
  }
}
```

`services/browser-worker/src/snapshot.ts`:
```ts
import type { Page } from "playwright-core";
import { EXTRACT_SNAPSHOT_SOURCE, type FormSnapshot, type PortalAdapter } from "@ai-career/browser";

/** Evaluated as a string expression: functions compiled by tsx would carry `__name` helpers the page lacks (D131). */
export async function takeSnapshot(page: Page, adapter: PortalAdapter): Promise<FormSnapshot> {
  return (await page.evaluate(`(${EXTRACT_SNAPSHOT_SOURCE})(${JSON.stringify(adapter.snapshotConfig)})`)) as FormSnapshot;
}

/** First 5,000 chars of visible text, for confirmation detection only. Never logged or stored. */
export async function readPageText(page: Page): Promise<string> {
  return (await page.evaluate(`document.body ? document.body.innerText.slice(0, 5000) : ""`)) as string;
}
```

`services/browser-worker/src/browser.ts`:
```ts
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

export interface BrowserOptions {
  headless: boolean;
  executablePath?: string;
}

export interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  /** Holds the throwaway profile (profile/) and the attachments (files/). Deleted on close. */
  rootDir: string;
  isClosed(): boolean;
  close(): Promise<void>;
}

/**
 * Design §5: a fresh persistent profile per session (no user cookies or logins), deleted with the attachments when
 * the window is closed. Attachments must outlive filling: Chrome reads an <input type=file> when the form is
 * submitted, which the user does later (D132).
 */
export async function launchBrowser(opts: BrowserOptions & { rootDir: string }): Promise<BrowserHandle> {
  const profileDir = path.join(opts.rootDir, "profile");
  await mkdir(profileDir, { recursive: true });
  const removeRoot = () => rm(opts.rootDir, { recursive: true, force: true }).catch(() => undefined);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...(opts.executablePath ? { executablePath: opts.executablePath } : { channel: "chrome" }),
      headless: opts.headless,
      viewport: null,
      acceptDownloads: false,
    });
  } catch (error) {
    await removeRoot();
    throw error;
  }
  let closed = false;
  context.on("close", () => {
    closed = true;
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    rootDir: opts.rootDir,
    isClosed: () => closed || context.pages().length === 0,
    close: async () => {
      if (!closed) await context.close().catch(() => undefined);
      closed = true;
      await removeRoot();
    },
  };
}

/**
 * Windows handed to the user after the job returns (needs_manual, submission_detected -- spec §11.6). Each is
 * closed at its deadline, when the user closes it, or on worker shutdown, so the queue is never blocked by one.
 */
export class ReleasedWindows {
  private readonly timers = new Map<BrowserHandle, NodeJS.Timeout>();

  release(handle: BrowserHandle, ms: number): void {
    const timer = setTimeout(() => void this.closeOne(handle), Math.max(0, ms));
    this.timers.set(handle, timer);
    handle.context.on("close", () => void this.closeOne(handle));
  }

  private async closeOne(handle: BrowserHandle): Promise<void> {
    const timer = this.timers.get(handle);
    if (timer) clearTimeout(timer);
    this.timers.delete(handle);
    await handle.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.timers.keys()].map((h) => this.closeOne(h)));
  }

  get size(): number {
    return this.timers.size;
  }
}
```

- [ ] **Step 6: Run the tests, typecheck and lint**

Run: `pnpm --filter @ai-career/browser-worker test && pnpm --filter @ai-career/browser-worker typecheck && pnpm --filter @ai-career/browser-worker lint`
Expected: PASS. If launch fails with "Chromium distribution 'chrome' is not found", Chrome is not installed: install Google Chrome, or set `BROWSER_EXECUTABLE_PATH` for the test run. Do not install Playwright's bundled Chromium.

- [ ] **Step 7: Commit**

```bash
git add packages/config services/browser-worker pnpm-lock.yaml
git commit -m "feat(browser-worker): guarded fill/select/check/attach layer, Chrome launch, no-click guard test"
```

---

### Task 7: Session runner, BullMQ worker and entry point

**Files:**
- Create: `services/browser-worker/src/attachments.ts`, `src/runSession.ts`, `src/worker.ts`, `src/main.ts`, `src/testing/fixtureServer.ts`
- Test: `services/browser-worker/src/runSession.test.ts`, `services/browser-worker/src/worker.test.ts`

**Interfaces:**
- Consumes: Task 5 session functions, Task 4 `buildAutofillValues`/`buildFillPlan`, Task 2 `getAdapter`/`detectSubmission`, Task 6 actions/browser/snapshot.
- Produces:
  - `attachments.ts`: `type FetchDocument = (objectKey: string) => Promise<Buffer>`, `downloadAttachments(fetch, docs, dir): Promise<{ paths: AttachmentPaths; failed: ("resume" | "cover_letter")[] }>`, `minioFetcher(client): FetchDocument`.
  - `runSession.ts`: `type RunSessionDeps = { db; fetchDocument; browser: BrowserOptions; timeoutMs; released: ReleasedWindows; extraAllowedHosts?: string[]; pollMs?: number; onBrowser?: (h: BrowserHandle) => void }`, `type RunSessionResult = AutomationStatus | "skipped"`, `runSession(deps, data: BrowserJobData): Promise<RunSessionResult>`.
  - `worker.ts`: `createBrowserWorker(deps: RunSessionDeps & { connection: ConnectionOptions; queueName?: string }): Worker<BrowserJobData, RunSessionResult>`.

- [ ] **Step 1: Write the fixture server (test infrastructure)**

`services/browser-worker/src/testing/fixtureServer.ts`:
```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFixture } from "@ai-career/browser/testing";

const THANKS = "<!doctype html><html><body><h1>Thank you for applying</h1></body></html>";

/**
 * Serves the sanitized real forms on 127.0.0.1 so the runner can be tested in real Chrome without the network.
 * /redirect-away sends the browser to "localhost" -- a different host than the allowed 127.0.0.1:<port>.
 */
export async function startFixtureServer(): Promise<{ origin: string; host: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    switch (req.url) {
      case "/greenhouse": return html(readFixture("greenhouse-v1-form.html"));
      case "/greenhouse/confirmation": return html(THANKS);
      case "/lever/apply": return html(readFixture("lever-v1-form.html"));
      case "/lever/thanks": return html(THANKS);
      case "/no-form": return html("<!doctype html><html><body><p>This job is no longer open.</p></body></html>");
      case "/redirect-away":
        res.writeHead(302, { location: `http://localhost:${port}/greenhouse` });
        return res.end();
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: Write the failing runner test**

`services/browser-worker/src/runSession.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { openTestDb, wipeUser, seedAutofillJob, insertSessionRow, type TestDb } from "@ai-career/browser/testing";
import { getSession, requestCancel, type FieldAuditEntry } from "@ai-career/browser";
import { runSession, type RunSessionDeps } from "./runSession";
import { ReleasedWindows, type BrowserHandle } from "./browser";
import { startFixtureServer } from "./testing/fixtureServer";

const USER = "00000000-0000-0000-0000-0000000008a5";
let t: TestDb;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let released: ReleasedWindows;
let handle: BrowserHandle | null;

beforeAll(async () => {
  t = await openTestDb();
  server = await startFixtureServer();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  released = new ReleasedWindows();
  handle = null;
});
afterAll(async () => {
  await released.closeAll();
  await wipeUser(t.adminSql, USER);
  await server.close();
  await t.close();
});

const deps = (over: Partial<RunSessionDeps> = {}): RunSessionDeps => ({
  db: t.db,
  fetchDocument: async () => Buffer.from("%PDF-1.4 test"),
  browser: { headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH },
  timeoutMs: 20_000,
  released,
  extraAllowedHosts: [server.host],
  pollMs: 100,
  onBrowser: (h) => {
    handle = h;
  },
  ...over,
});

async function waitForStatus(id: string, status: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getSession(t.db, USER, id);
    if (row?.status === status) return row;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}, last ${row?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const filled = (audit: unknown) => (audit as FieldAuditEntry[]).filter((a) => a.action === "filled").map((a) => a.canonical).sort();

describe("runSession against the Greenhouse fixture", () => {
  it("fills, attaches, waits, then detects the confirmation page and releases the window", async () => {
    const { jobId, resumeDocumentId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { formUrl: `${server.origin}/greenhouse` });
    const result = runSession(deps(), { sessionId: id, userId: USER });

    const waiting = await waitForStatus(id, "awaiting_user");
    expect(filled(waiting.fieldAudit)).toEqual(["email", "first_name", "last_name", "linkedin", "phone", "resume"]);
    expect((waiting.fieldAudit as FieldAuditEntry[]).filter((a) => a.action === "filled").every((a) => a.verified)).toBe(true);
    expect(waiting.resumeDocumentId).toBe(resumeDocumentId);
    expect(waiting.stoppedBeforeSubmit).toBe(true);
    expect(await handle!.page.inputValue("#first_name")).toBe("Jane");
    expect(await handle!.page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(1);

    await handle!.page.goto(`${server.origin}/greenhouse/confirmation`); // what the ATS does after the user submits
    expect(await result).toBe("submission_detected");
    const row = await getSession(t.db, USER, id);
    expect(row).toMatchObject({ status: "submission_detected", errorCode: null });
    expect(row!.submissionDetectedAt).not.toBeNull();
    expect(released.size).toBe(1);
    await released.closeAll();
    expect(handle!.isClosed()).toBe(true);
  });

  it("flags a resume that cannot be downloaded and still hands over the window", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { formUrl: `${server.origin}/greenhouse` });
    const result = runSession(deps({ fetchDocument: async () => { throw new Error("minio down"); } }), { sessionId: id, userId: USER });
    const waiting = await waitForStatus(id, "awaiting_user");
    expect((waiting.fieldAudit as FieldAuditEntry[]).find((a) => a.canonical === "resume")).toMatchObject({
      action: "flagged", reason: "attachment_unavailable",
    });
    expect(waiting.resumeDocumentId).toBeNull();
    await requestCancel(t.db, USER, id);
    expect(await result).toBe("abandoned");
  });
});

describe("runSession against the Lever fixture", () => {
  it("answers the sponsorship radio from the goal and flags the location widget", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { sourceKind: "lever" });
    const id = await insertSessionRow(t.adminSql, USER, jobId, { portal: "lever", formUrl: `${server.origin}/lever/apply` });
    const result = runSession(deps(), { sessionId: id, userId: USER });
    const waiting = await waitForStatus(id, "awaiting_user");
    expect(filled(waiting.fieldAudit)).toEqual(["email", "full_name", "linkedin", "phone", "resume", "sponsorship"]);
    expect(
      await handle!.page.locator('input[name="cards[1c719ca9-5069-4afe-9e82-39ca420e0edb][field1]"][value="No"]').isChecked()
    ).toBe(true);
    expect((waiting.fieldAudit as FieldAuditEntry[]).find((a) => a.canonical === "location")).toMatchObject({ action: "flagged", reason: "autocomplete_widget" });
    await handle!.page.goto(`${server.origin}/lever/thanks`);
    expect(await result).toBe("submission_detected");
    await released.closeAll();
  });
});

describe("runSession endings", () => {
  const start = async (path: string, over: Partial<RunSessionDeps> = {}) => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { formUrl: path.startsWith("http") ? path : `${server.origin}${path}` });
    return { id, result: runSession(deps(over), { sessionId: id, userId: USER }) };
  };

  it("abandons on cancel and closes the window", async () => {
    const { id, result } = await start("/greenhouse");
    await waitForStatus(id, "awaiting_user");
    await requestCancel(t.db, USER, id);
    expect(await result).toBe("abandoned");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "cancelled" });
    expect(handle!.isClosed()).toBe(true);
  });

  it("abandons when the user closes the window", async () => {
    const { id, result } = await start("/greenhouse");
    await waitForStatus(id, "awaiting_user");
    await handle!.context.close();
    expect(await result).toBe("abandoned");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "window_closed" });
  });

  it("abandons at the session timeout", async () => {
    const { id, result } = await start("/greenhouse", { timeoutMs: 1_500 });
    expect(await result).toBe("abandoned");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "timeout" });
  });

  it("needs manual work when the form is missing, and releases the window", async () => {
    const { id, result } = await start("/no-form");
    expect(await result).toBe("needs_manual");
    const row = await getSession(t.db, USER, id);
    expect(row).toMatchObject({ errorCode: "health_check_failed" });
    expect(released.size).toBe(1);
    await released.closeAll();
  });

  it("needs manual work after a redirect to another host, without filling", async () => {
    const { id, result } = await start("/redirect-away");
    expect(await result).toBe("needs_manual");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "off_host_redirect", fieldAudit: [] });
    await released.closeAll();
  });

  it("refuses a stored form URL outside the allowed hosts before launching", async () => {
    const { id, result } = await start("https://evil.example/apply");
    expect(await result).toBe("needs_manual");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "form_url_not_allowed" });
    expect(handle).toBeNull();
  });

  it("fails cleanly when Chrome cannot start", async () => {
    const { id, result } = await start("/greenhouse", { browser: { headless: true, executablePath: "/nonexistent/chrome" } });
    expect(await result).toBe("failed");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "browser_launch_failed" });
  });

  it("skips a session that is no longer queued", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { status: "abandoned" });
    expect(await runSession(deps(), { sessionId: id, userId: USER })).toBe("skipped");
  });
});
```

`services/browser-worker/src/worker.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { openTestDb, wipeUser, seedAutofillJob, insertSessionRow, type TestDb } from "@ai-career/browser/testing";
import { BROWSER_JOB_NAME, browserJobId, type BrowserJobData } from "@ai-career/browser";
import { createBrowserWorker } from "./worker";
import type { RunSessionResult } from "./runSession";
import { ReleasedWindows } from "./browser";

const USER = "00000000-0000-0000-0000-0000000008a6";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `browser-test-${randomUUID()}`;

let t: TestDb;
let queue: Queue<BrowserJobData>;
let events: QueueEvents;
let worker: Worker<BrowserJobData, RunSessionResult>;

beforeAll(async () => {
  t = await openTestDb();
  await wipeUser(t.adminSql, USER);
  queue = new Queue<BrowserJobData>(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createBrowserWorker({
    connection, queueName, db: t.db, fetchDocument: async () => Buffer.from("x"), browser: { headless: true },
    timeoutMs: 1_000, released: new ReleasedWindows(),
  });
  await worker.waitUntilReady();
});
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

describe("browser worker", () => {
  it("hands queued jobs to runSession (a non-queued session is skipped without opening a browser)", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const sessionId = await insertSessionRow(t.adminSql, USER, jobId, { status: "failed" });
    const job = await queue.add(BROWSER_JOB_NAME, { sessionId, userId: USER }, { jobId: browserJobId(sessionId) });
    expect(await job.waitUntilFinished(events)).toBe("skipped");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @ai-career/browser-worker test -- runSession worker`
Expected: FAIL — `./runSession`, `./worker` not found.

- [ ] **Step 4: Implement**

`services/browser-worker/src/attachments.ts`:
```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "minio";
import { getGeneratedDocument } from "@ai-career/storage";
import type { StoredDocumentRef } from "@ai-career/browser";
import type { AttachmentPaths } from "./actions";

export type FetchDocument = (objectKey: string) => Promise<Buffer>;

export function minioFetcher(client: Client): FetchDocument {
  return async (objectKey) => {
    const stream = await getGeneratedDocument(client, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
}

/** Fixed file names: the stored key and the user's download name never reach the page. A failure is reported, not thrown. */
export async function downloadAttachments(
  fetchDocument: FetchDocument,
  docs: { resume: StoredDocumentRef | null; coverLetter: StoredDocumentRef | null },
  dir: string
): Promise<{ paths: AttachmentPaths; failed: ("resume" | "cover_letter")[] }> {
  await mkdir(dir, { recursive: true });
  const paths: AttachmentPaths = {};
  const failed: ("resume" | "cover_letter")[] = [];
  for (const [kind, doc] of [["resume", docs.resume], ["cover_letter", docs.coverLetter]] as const) {
    if (!doc) continue;
    try {
      const file = path.join(dir, `${kind}.pdf`);
      await writeFile(file, await fetchDocument(doc.objectKey));
      paths[kind] = file;
    } catch {
      failed.push(kind);
    }
  }
  return { paths, failed };
}
```

`services/browser-worker/src/runSession.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { DbClient } from "@ai-career/db";
import {
  ACTIVE_STATUSES, buildAutofillValues, buildFillPlan, detectSubmission, failSession, getAdapter, isCancelRequested,
  loadAutofillContext, transitionSession,
  type AutomationStatus, type BrowserJobData, type FieldAuditEntry, type PortalAdapter, type TransitionPatch,
} from "@ai-career/browser";
import { GuardViolation, performAction, verifyAction } from "./actions";
import { downloadAttachments, type FetchDocument } from "./attachments";
import { launchBrowser, type BrowserHandle, type BrowserOptions, type ReleasedWindows } from "./browser";
import { readPageText, takeSnapshot } from "./snapshot";

const NAVIGATION_TIMEOUT_MS = 30_000;
const FORM_WAIT_MS = 15_000;

export interface RunSessionDeps {
  db: DbClient;
  fetchDocument: FetchDocument;
  browser: BrowserOptions;
  /** BROWSER_SESSION_TIMEOUT_MIN in ms: how long the window waits for the user. */
  timeoutMs: number;
  released: ReleasedWindows;
  /** Tests only: extra "host:port" values allowed (over http too), e.g. the local fixture server. */
  extraAllowedHosts?: string[];
  pollMs?: number;
  /** Tests only: observe the live browser. */
  onBrowser?: (handle: BrowserHandle) => void;
}

export type RunSessionResult = AutomationStatus | "skipped";

function hostAllowed(url: string, adapter: PortalAdapter, extra: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (extra.includes(u.host)) return u.protocol === "http:" || u.protocol === "https:";
  return u.protocol === "https:" && adapter.allowedHosts.includes(u.hostname);
}

/** Attachments that failed to download read better as "attachment_unavailable" than "no_resume_export"/"no_value". */
function markUnavailable(audit: FieldAuditEntry[], failed: ("resume" | "cover_letter")[]): FieldAuditEntry[] {
  return audit.map((a) =>
    a.canonical !== null && (failed as string[]).includes(a.canonical) && a.action !== "filled"
      ? { ...a, action: "flagged", reason: "attachment_unavailable" }
      : a
  );
}

/**
 * Design §5. Runs one session end to end. Status is written after every step and every transition is conditional,
 * so a cancel or a startup sweep in between simply makes the next transition a no-op. The window is closed on every
 * ending except needs_manual and submission_detected, where it is released to the user (spec §11.6).
 * Holds no domain rules: classification, values and detection all come from @ai-career/browser.
 */
export async function runSession(deps: RunSessionDeps, data: BrowserJobData): Promise<RunSessionResult> {
  const { db } = deps;
  const { sessionId, userId } = data;
  const pollMs = deps.pollMs ?? 1_000;
  const extra = deps.extraAllowedHosts ?? [];

  const claimed = await transitionSession(db, userId, sessionId, ["queued"], "launching", { startedAt: new Date() });
  if (!claimed) return "skipped";
  const adapter = getAdapter(claimed.portal);

  let handle: BrowserHandle | null = null;
  let releaseMs: number | null = null;

  const end = async (to: AutomationStatus, patch: TransitionPatch = {}): Promise<RunSessionResult> => {
    const row = await transitionSession(db, userId, sessionId, ACTIVE_STATUSES, to, patch);
    return row ? to : "skipped";
  };
  const release = (to: AutomationStatus, patch: TransitionPatch, ms: number) => {
    releaseMs = ms;
    return end(to, patch);
  };

  try {
    if (!hostAllowed(claimed.formUrl, adapter, extra)) return await end("needs_manual", { errorCode: "form_url_not_allowed" });

    const ctx = await loadAutofillContext(db, userId, sessionId);
    const rootDir = await mkdtemp(path.join(tmpdir(), "careerpilot-autofill-"));
    const { paths, failed } = await downloadAttachments(
      deps.fetchDocument, { resume: ctx.resumeDocument, coverLetter: ctx.coverLetterDocument }, path.join(rootDir, "files")
    );
    try {
      handle = await launchBrowser({ ...deps.browser, rootDir });
    } catch {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
      return await end("failed", { errorCode: "browser_launch_failed" });
    }
    deps.onBrowser?.(handle);

    if (await isCancelRequested(db, userId, sessionId)) return await end("abandoned", { errorCode: "cancelled" });
    if (!(await transitionSession(db, userId, sessionId, ["launching"], "filling"))) return "skipped";

    const page = handle.page;
    try {
      const response = await page.goto(claimed.formUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      if (response && !response.ok()) return await release("needs_manual", { errorCode: "navigation_failed" }, deps.timeoutMs);
    } catch {
      return await release("needs_manual", { errorCode: "navigation_failed" }, deps.timeoutMs);
    }
    if (!hostAllowed(page.url(), adapter, extra)) return await release("needs_manual", { errorCode: "off_host_redirect" }, deps.timeoutMs);
    await page.waitForSelector(adapter.snapshotConfig.formSelector, { state: "attached", timeout: FORM_WAIT_MS }).catch(() => undefined);

    const snapshot = await takeSnapshot(page, adapter);
    const values = buildAutofillValues({
      profile: ctx.profile, goal: ctx.goal, attachments: { resume: Boolean(paths.resume), coverLetter: Boolean(paths.cover_letter) },
    });
    const plan = buildFillPlan(snapshot, adapter, values);
    const audit = markUnavailable(plan.audit, failed);
    if (!plan.healthy) return await release("needs_manual", { errorCode: "health_check_failed", fieldAudit: audit }, deps.timeoutMs);

    for (const action of plan.actions) {
      if (await isCancelRequested(db, userId, sessionId)) return await end("abandoned", { errorCode: "cancelled", fieldAudit: audit });
      const entry = audit.find((a) => a.key === action.fieldKey)!;
      try {
        await performAction(page, action, paths);
        entry.verified = await verifyAction(page, action);
        if (!entry.verified) Object.assign(entry, { action: "flagged", reason: "verify_mismatch" });
      } catch (error) {
        Object.assign(entry, { action: "flagged", reason: error instanceof GuardViolation ? "guard_blocked" : "fill_error", verified: false });
      }
    }

    const awaiting = await transitionSession(db, userId, sessionId, ["filling"], "awaiting_user", {
      fieldAudit: audit,
      resumeDocumentId: paths.resume ? ctx.resumeDocument!.id : null,
      coverLetterDocumentId: paths.cover_letter ? ctx.coverLetterDocument!.id : null,
    });
    if (!awaiting) return "skipped";

    // Design §5 step 3 / spec §11.7: one polling loop for close, timeout, cancel and confirmation detection.
    const waitingSince = Date.now();
    for (let tick = 1; ; tick++) {
      await sleep(pollMs);
      if (handle.isClosed()) return await end("abandoned", { errorCode: "window_closed" });
      const elapsed = Date.now() - waitingSince;
      if (elapsed >= deps.timeoutMs) return await end("abandoned", { errorCode: "timeout" });
      if (tick % 2 === 0 && (await isCancelRequested(db, userId, sessionId))) return await end("abandoned", { errorCode: "cancelled" });
      for (const p of handle.context.pages()) {
        if (p.isClosed()) continue;
        const text = await readPageText(p).catch(() => "");
        if (detectSubmission(adapter, { url: p.url(), text, formUrl: claimed.formUrl })) {
          return await release("submission_detected", { submissionDetectedAt: new Date() }, deps.timeoutMs - elapsed);
        }
      }
    }
  } catch {
    await failSession(db, userId, sessionId, "unexpected_error").catch(() => undefined);
    return "failed";
  } finally {
    if (handle) {
      if (releaseMs !== null && !handle.isClosed()) deps.released.release(handle, releaseMs);
      else await handle.close();
    }
  }
}
```

`services/browser-worker/src/worker.ts`:
```ts
import { Worker, type ConnectionOptions } from "bullmq";
import { BROWSER_QUEUE_NAME, type BrowserJobData } from "@ai-career/browser";
import { runSession, type RunSessionDeps, type RunSessionResult } from "./runSession";

export interface BrowserWorkerDeps extends RunSessionDeps {
  connection: ConnectionOptions;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/**
 * Concurrency 1: one automated window at a time (the DB's one-active-session index says the same). A job can
 * run for the whole session timeout; BullMQ renews the lock while the event loop is free.
 */
export function createBrowserWorker(deps: BrowserWorkerDeps): Worker<BrowserJobData, RunSessionResult> {
  return new Worker<BrowserJobData, RunSessionResult>(
    deps.queueName ?? BROWSER_QUEUE_NAME,
    (job) => runSession(deps, job.data),
    { connection: deps.connection, concurrency: 1, lockDuration: 60_000 }
  );
}
```

`services/browser-worker/src/main.ts`:
```ts
import IORedis from "ioredis";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { sweepInterruptedSessions } from "@ai-career/browser";
import { minioFetcher } from "./attachments";
import { ReleasedWindows } from "./browser";
import { createBrowserWorker } from "./worker";

// Structured logs only: ids, statuses and error classes -- never field values, labels or URLs (CLAUDE.md §9).
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
const safeErrorLabel = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const released = new ReleasedWindows();

  // Spec §11.5: sessions a previous worker process owned can never finish now.
  const swept = await sweepInterruptedSessions(db, env.DEFAULT_USER_ID);

  const worker = createBrowserWorker({
    connection,
    db,
    fetchDocument: minioFetcher(createStorageClient(env)),
    browser: { headless: env.BROWSER_HEADLESS, executablePath: env.BROWSER_EXECUTABLE_PATH },
    timeoutMs: env.BROWSER_SESSION_TIMEOUT_MIN * 60_000,
    released,
  });
  worker.on("completed", (job, result) => log("autofill_completed", { sessionId: job.data.sessionId, result }));
  worker.on("failed", (job, error) => log("autofill_failed", { sessionId: job?.data.sessionId, error: safeErrorLabel(error) }));
  log("worker_started", { sweptSessions: swept, headless: env.BROWSER_HEADLESS });

  const shutdown = async () => {
    // force: an active session may be waiting minutes for the user; the next start sweeps it to failed.
    await worker.close(true);
    await released.closeAll();
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

- [ ] **Step 5: Run the worker suite, typecheck and lint**

Run: `pnpm --filter @ai-career/browser-worker test && pnpm --filter @ai-career/browser-worker typecheck && pnpm --filter @ai-career/browser-worker lint`
Expected: all PASS, including `noClick.test.ts` now scanning `actions.ts`, `attachments.ts`, `browser.ts`, `runSession.ts`, `snapshot.ts`, `worker.ts`, `main.ts`. If a fixture assertion fails, look at the session's `field_audit` reasons (`verify_mismatch`, `fill_error`, `guard_blocked`) before changing expectations.

- [ ] **Step 6: Smoke-start the real entry point**

Run (Docker services up): `timeout 8 pnpm --filter @ai-career/browser-worker start; echo exit=$?`
Expected: a `{"event":"worker_started","sweptSessions":0,...}` log line, then exit 124 from `timeout` (no crash). No Chrome window opens (nothing is queued).

- [ ] **Step 7: Commit**

```bash
git add services/browser-worker pnpm-lock.yaml
git commit -m "feat(browser-worker): session runner with health check, read-back audit, detection, cancel/timeout, released windows"
```

---
### Task 8: Link a session to an application (`automationSessionId`)

**Files:**
- Modify: `packages/applications/src/bodies.ts`, `src/errors.ts`, `src/createApplication.ts`, `src/index.ts`
- Create: `packages/applications/src/sessionLink.ts`
- Test: `packages/applications/src/createApplication.test.ts`, `packages/applications/src/bodies.test.ts`

**Interfaces:**
- Consumes: `schema.automationSessions` (Task 1), `schema.generatedDocuments`.
- Produces: `CreateApplicationBody.automationSessionId?: string` (requires `jobId`); new `ApplicationErrorClass` member `"session_not_linkable"`. When a session is given: it must be this user's, for the same job, in `submission_detected` or `abandoned`, and unlinked; document ids the body leaves `undefined` default to the session's attached files' sources; `automation_sessions.application_id` is set in the same transaction.

- [ ] **Step 1: Write the failing tests**

Append to the `describe` in `packages/applications/src/bodies.test.ts`:
```ts
  it("accepts automationSessionId only together with jobId", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(CreateApplicationBodySchema.safeParse({ jobId: id, automationSessionId: id }).success).toBe(true);
    const external = CreateApplicationBodySchema.safeParse({ external: { companyName: "A", jobTitle: "B" }, automationSessionId: id });
    expect(external.success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ jobId: id, automationSessionId: "nope" }).success).toBe(false);
  });
```
(If `CreateApplicationBodySchema` is not yet imported in that file, add it to the existing import from `./bodies`.)

Append to `describe("createApplication", ...)` in `packages/applications/src/createApplication.test.ts`:
```ts
  async function seedSession(jobId: string, status: string, docs: { resumeOptimizationId?: string; coverLetterId?: string } = {}) {
    const doc = async (kind: "resume" | "cover_letter", sourceId: string | undefined) => {
      if (!sourceId) return null;
      const [row] = await t.adminSql`
        INSERT INTO generated_documents (user_id, job_id, kind, format, resume_optimization_id, cover_letter_id, object_key, byte_size,
                                         content_hash, renderer_version, download_filename)
        VALUES (${USER}, ${jobId}, ${kind}, 'pdf', ${kind === "resume" ? sourceId : null}, ${kind === "cover_letter" ? sourceId : null},
                ${`${USER}/${kind}.pdf`}, 10, ${"h-" + kind}, 'r1', ${kind + ".pdf"})
        RETURNING id`;
      return row.id as string;
    };
    const terminal = ["submission_detected", "abandoned", "needs_manual", "failed"].includes(status);
    const [row] = await t.adminSql`
      INSERT INTO automation_sessions (user_id, job_id, portal, adapter_version, form_url, status, ended_at, resume_document_id, cover_letter_document_id)
      VALUES (${USER}, ${jobId}, 'greenhouse', 'greenhouse-v1', 'https://job-boards.greenhouse.io/acme/jobs/1', ${status},
              ${terminal ? NOW.toISOString() : null}::timestamptz, ${await doc("resume", docs.resumeOptimizationId)},
              ${await doc("cover_letter", docs.coverLetterId)})
      RETURNING id`;
    return row.id as string;
  }

  it("links a detected-submission session and defaults the documents to the files it attached", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const sessionId = await seedSession(s.jobId, "submission_detected", { resumeOptimizationId: s.resumeId, coverLetterId: s.coverLetterId });
    const row = await createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: sessionId }, NOW);
    expect(row).toMatchObject({ resumeOptimizationId: s.resumeId, coverLetterId: s.coverLetterId, applicationPitchId: null });
    const [session] = await t.adminSql`SELECT application_id FROM automation_sessions WHERE id = ${sessionId}`;
    expect(session.application_id).toBe(row.id);
  });

  it("lets explicit body ids win over the session's attachments", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const sessionId = await seedSession(s.jobId, "abandoned", { resumeOptimizationId: s.resumeId });
    const row = await createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: sessionId, resumeOptimizationId: null }, NOW);
    expect(row.resumeOptimizationId).toBeNull();
  });

  it("rejects a session that is active, already linked, for another job or unknown", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const active = await seedSession(s.jobId, "awaiting_user");
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: active }, NOW))).toBe("session_not_linkable");
    const other = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    const otherJobSession = await seedSession(other.jobId, "abandoned");
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: otherJobSession }, NOW))).toBe("session_not_linkable");
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: "11111111-1111-4111-8111-111111111111" }, NOW))).toBe("session_not_linkable");
    const done = await seedSession(other.jobId, "submission_detected");
    await createApplication(t.db, USER, { jobId: other.jobId, automationSessionId: done }, NOW);
    // Free the job for the "already linked" case (deleting the application SET NULLs `done`'s link).
    await t.adminSql`DELETE FROM applications WHERE job_id = ${other.jobId}`;
    const linked = await seedSession(other.jobId, "abandoned");
    const [app] = await t.adminSql`
      INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot)
      VALUES (${USER}, null, 'Elsewhere', 'Role', 'applied', now(), current_date, '{}'::jsonb) RETURNING id`;
    await t.adminSql`UPDATE automation_sessions SET application_id = ${app.id} WHERE id = ${linked}`;
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: other.jobId, automationSessionId: linked }, NOW))).toBe("session_not_linkable");
    expect(await t.adminSql`SELECT 1 FROM applications WHERE job_id = ${other.jobId}`).toHaveLength(0);
    expect(await t.adminSql`SELECT 1 FROM applications WHERE job_id = ${s.jobId}`).toHaveLength(0);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ai-career/applications test -- createApplication bodies`
Expected: FAIL — `automationSessionId` is rejected by the strict schema; `session_not_linkable` never thrown.

- [ ] **Step 3: Implement**

In `packages/applications/src/bodies.ts`, add to the `CreateApplicationBodySchema` object (after `notes`):
```ts
    /** Phase 8: the autofill session this application came from. Only with jobId. */
    automationSessionId: Uuid.optional(),
```
and inside its `superRefine`, after the existing checks:
```ts
    if (body.automationSessionId && !body.jobId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["automationSessionId"], message: "automationSessionId requires jobId" });
    }
```

In `packages/applications/src/errors.ts` extend the union:
```ts
export type ApplicationErrorClass =
  | "job_not_found" | "already_applied" | "document_mismatch" | "not_found" | "same_status" | "session_not_linkable";
```

`packages/applications/src/sessionLink.ts`:
```ts
import { eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import type { DocumentLinkIds } from "./documentLinks";

const { automationSessions, generatedDocuments } = schema;

const LINKABLE = new Set(["submission_detected", "abandoned"]);

export interface LinkableSession {
  id: string;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
}

/**
 * Phase 8 design §6. Call inside withUserContext. Locks the session so two "Record as applied" clicks cannot both
 * link it. Unknown (or another user's, hidden by RLS), other-job, still-active and already-linked sessions are all
 * `session_not_linkable`.
 */
export async function lockLinkableSession(tx: DbClient, sessionId: string, jobId: string): Promise<LinkableSession> {
  const [row] = await tx
    .select({
      id: automationSessions.id, jobId: automationSessions.jobId, status: automationSessions.status,
      applicationId: automationSessions.applicationId, resumeDocumentId: automationSessions.resumeDocumentId,
      coverLetterDocumentId: automationSessions.coverLetterDocumentId,
    })
    .from(automationSessions)
    .where(eq(automationSessions.id, sessionId))
    .for("update");
  if (!row || row.jobId !== jobId || !LINKABLE.has(row.status) || row.applicationId !== null) {
    throw new ApplicationError("session_not_linkable");
  }
  return { id: row.id, resumeDocumentId: row.resumeDocumentId, coverLetterDocumentId: row.coverLetterDocumentId };
}

/** Spec §11.8: ids the body leaves undefined default to the sources of the files the session actually attached. */
export async function withSessionDocuments(tx: DbClient, session: LinkableSession, body: DocumentLinkIds): Promise<DocumentLinkIds> {
  const sourceOf = async (documentId: string | null) => {
    if (!documentId) return null;
    const [doc] = await tx
      .select({ resumeOptimizationId: generatedDocuments.resumeOptimizationId, coverLetterId: generatedDocuments.coverLetterId })
      .from(generatedDocuments)
      .where(eq(generatedDocuments.id, documentId));
    return doc ?? null;
  };
  const resume = await sourceOf(session.resumeDocumentId);
  const letter = await sourceOf(session.coverLetterDocumentId);
  return {
    resumeOptimizationId: body.resumeOptimizationId !== undefined ? body.resumeOptimizationId : (resume?.resumeOptimizationId ?? null),
    applicationPitchId: body.applicationPitchId,
    coverLetterId: body.coverLetterId !== undefined ? body.coverLetterId : (letter?.coverLetterId ?? null),
  };
}
```

In `packages/applications/src/createApplication.ts`:
- add imports:
```ts
import { lockLinkableSession, withSessionDocuments, type LinkableSession } from "./sessionLink";
```
- extend the destructuring: `const { jobs, jobPostings, jobMatches, applications, applicationEvents, automationSessions } = schema;`
- declare `let session: LinkableSession | null = null;` right after `let values: ...;`
- in the ingested branch, replace `const docs = await loadLinkedDocuments(tx, jobId, body);` with:
```ts
        if (body.automationSessionId) session = await lockLinkableSession(tx, body.automationSessionId, jobId);
        const docs = await loadLinkedDocuments(tx, jobId, session ? await withSessionDocuments(tx, session, body) : body);
```
- after the `application_events` insert and before `return row;`:
```ts
      if (session) {
        await tx.update(automationSessions).set({ applicationId: row.id, updatedAt: now }).where(eq(automationSessions.id, session.id));
      }
```
- add one sentence to the function's doc comment: "With automationSessionId (Phase 8), the session is locked, validated and linked in the same transaction."

- [ ] **Step 4: Run the package suite, typecheck and lint**

Run: `pnpm --filter @ai-career/applications test && pnpm --filter @ai-career/applications typecheck && pnpm --filter @ai-career/applications lint`
Expected: all PASS (existing tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/applications
git commit -m "feat(applications): record an application from an autofill session and link the attached documents"
```

---

### Task 9: Web API — enqueue and `/api/automation-sessions` routes

**Files:**
- Modify: `apps/web/package.json` (dependency `"@ai-career/browser": "workspace:*"`), `apps/web/src/lib/applications/errorResponse.ts`, `apps/web/src/test/jobsDb.ts`
- Create: `apps/web/src/lib/browser-automation/enqueue.ts`, `serializeSession.ts`, `errorResponse.ts`
- Create: `apps/web/src/app/api/automation-sessions/route.ts`, `[id]/route.ts`, `[id]/cancel/route.ts`
- Test: `apps/web/src/lib/browser-automation/serializeSession.test.ts`, `apps/web/src/app/api/automation-sessions/route.test.ts`, `apps/web/src/app/api/automation-sessions/[id]/route.test.ts`, and one added case in `apps/web/src/app/api/applications/route.test.ts`

**Interfaces:**
- Consumes: Task 5 (`createSession`, `getSession`, `getJobAutofillOverview`, `requestCancel`, `failSession`, `AutomationError`), Task 2 queue constants, Task 8.
- Produces:
  - `enqueueAutofill(env: { REDIS_URL: string }, data: BrowserJobData, queueName?: string): Promise<void>` — throws `Error("queue unavailable")`.
  - `toSessionView(row: SessionRow): SessionView` with `SessionView = { id, jobId, status, portal, adapterVersion, formUrl, fieldAudit, errorCode, applicationId, resumeDocumentId, coverLetterDocumentId, stoppedBeforeSubmit, cancelRequested: boolean, submissionDetectedAt, startedAt, endedAt, createdAt }` (dates as ISO strings or null).
  - `GET /api/automation-sessions?jobId=` → `{ support, resumeAvailable, applicationId, sessions: SessionView[] }`; `POST /api/automation-sessions {jobId}` → 201 `{ session }`; `GET /api/automation-sessions/[id]` → `{ session }`; `POST /api/automation-sessions/[id]/cancel` → `{ session }`.
  - Test helpers in `apps/web/src/test/jobsDb.ts`: `insertProfile(admin, userId)`, `insertGeneratedPdf(admin, userId, jobId, kind)`, `insertAutomationSession(admin, userId, jobId, opts?)`.

- [ ] **Step 1: Add the dependency and test helpers**

Add `"@ai-career/browser": "workspace:*"` to `apps/web/package.json` dependencies, between `@ai-career/applications` and `@ai-career/config`, and run `pnpm install`.

Append to `apps/web/src/test/jobsDb.ts`:
```ts
/** Phase 8. candidate_profiles has one row per user and does not cascade from jobs: tests delete it themselves. */
export async function insertProfile(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`
    INSERT INTO candidate_profiles (user_id, full_name, email) VALUES (${userId}, 'Jane Doe', 'jane@example.com')
    ON CONFLICT (user_id) DO NOTHING`;
}

export async function insertGeneratedPdf(adminSql: postgres.Sql, userId: string, jobId: string, kind: "resume" | "cover_letter"): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
    VALUES (${userId}, ${jobId}, ${kind}, 'pdf', ${`${userId}/${kind}-${jobId}.pdf`}, 10, ${"h-" + kind}, 'r1', ${kind + ".pdf"})
    RETURNING id`;
  return row.id as string;
}

export async function insertAutomationSession(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  opts: { status?: string; fieldAudit?: object[] } = {}
): Promise<string> {
  const status = opts.status ?? "queued";
  const terminal = ["submission_detected", "abandoned", "needs_manual", "failed"].includes(status);
  const [row] = await adminSql`
    INSERT INTO automation_sessions (user_id, job_id, portal, adapter_version, form_url, status, ended_at, field_audit)
    VALUES (${userId}, ${jobId}, 'greenhouse', 'greenhouse-v1', 'https://job-boards.greenhouse.io/acme/jobs/123', ${status},
            ${terminal ? new Date().toISOString() : null}::timestamptz, ${JSON.stringify(opts.fieldAudit ?? [])}::jsonb)
    RETURNING id`;
  return row.id as string;
}
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/lib/browser-automation/serializeSession.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { SessionRow } from "@ai-career/browser";
import { toSessionView } from "./serializeSession";

const row = {
  id: "s1", userId: "u1", jobId: "j1", applicationId: null, portal: "greenhouse", adapterVersion: "greenhouse-v1",
  formUrl: "https://job-boards.greenhouse.io/acme/jobs/1", status: "awaiting_user", resumeDocumentId: "d1", coverLetterDocumentId: null,
  fieldAudit: [{ key: "f0", label: "Email", required: true, canonical: "email", action: "filled", reason: null, valueSource: "profile.email", verified: true }],
  stoppedBeforeSubmit: true, cancelRequestedAt: new Date("2026-10-01T10:00:00Z"), errorCode: null, submissionDetectedAt: null,
  startedAt: new Date("2026-10-01T09:59:00Z"), endedAt: null, createdAt: new Date("2026-10-01T09:58:00Z"), updatedAt: new Date(),
} as SessionRow;

describe("toSessionView", () => {
  it("exposes the audit and ISO dates, a cancel flag, and no user id", () => {
    const view = toSessionView(row);
    expect(view).toMatchObject({
      id: "s1", status: "awaiting_user", portal: "greenhouse", cancelRequested: true, startedAt: "2026-10-01T09:59:00.000Z",
      endedAt: null, createdAt: "2026-10-01T09:58:00.000Z",
    });
    expect(view.fieldAudit).toHaveLength(1);
    expect(view).not.toHaveProperty("userId");
  });
});
```

`apps/web/src/app/api/automation-sessions/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import {
  openAdminDb, wipeMatchingData, insertJob, insertSource, insertPosting, insertProfile, insertGeneratedPdf, insertAutomationSession,
} from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000008a7",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../lib/browser-automation/enqueue", () => ({ enqueueAutofill: vi.fn() }));
import { enqueueAutofill } from "../../../lib/browser-automation/enqueue";

const USER = "00000000-0000-0000-0000-0000000008a7";
let admin: postgres.Sql;

const wipe = async () => {
  await wipeMatchingData(admin, USER);
  await admin`DELETE FROM candidate_profiles WHERE user_id = ${USER}`;
};
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueAutofill).mockReset().mockResolvedValue(undefined);
  await wipe();
});
afterAll(async () => {
  await wipe();
  await admin.end();
});

const { GET, POST } = await import("./route");
const post = (body: string) =>
  POST(new Request("http://localhost/api/automation-sessions", { method: "POST", body, headers: { "Content-Type": "application/json" } }));
const get = (query: string) => GET(new Request(`http://localhost/api/automation-sessions${query}`));

async function greenhouseJob() {
  const jobId = await insertJob(admin, USER, {});
  const sourceId = await insertSource(admin, USER, { kind: "greenhouse", slug: "acme" });
  await insertPosting(admin, USER, jobId, sourceId, { externalId: "123" });
  return jobId;
}

describe("POST /api/automation-sessions", () => {
  it("creates a queued session and enqueues it", async () => {
    await insertProfile(admin, USER);
    const jobId = await greenhouseJob();
    const res = await post(JSON.stringify({ jobId }));
    expect(res.status).toBe(201);
    const { session } = await res.json();
    expect(session).toMatchObject({ jobId, status: "queued", portal: "greenhouse", formUrl: "https://job-boards.greenhouse.io/acme/jobs/123" });
    expect(enqueueAutofill).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), { sessionId: session.id, userId: USER });
  });

  it("maps validation and domain errors to 400/404/409/422", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post(JSON.stringify({ jobId: "x" }))).status).toBe(400);
    expect((await post(JSON.stringify({ jobId: "11111111-1111-4111-8111-111111111111" }))).status).toBe(404);
    const jobId = await greenhouseJob();
    expect((await post(JSON.stringify({ jobId }))).status).toBe(409); // no profile
    await insertProfile(admin, USER);
    const uploadJob = await insertJob(admin, USER, { title: "Analyst" });
    const unsupported = await post(JSON.stringify({ jobId: uploadJob }));
    expect(unsupported.status).toBe(422);
    expect((await unsupported.json()).reason).toBe("no_supported_posting");
    expect((await post(JSON.stringify({ jobId }))).status).toBe(201);
    expect((await post(JSON.stringify({ jobId }))).status).toBe(409); // session_active
  });

  it("answers 503 and marks the session failed when the queue is down", async () => {
    vi.mocked(enqueueAutofill).mockRejectedValue(new Error("queue unavailable"));
    await insertProfile(admin, USER);
    const jobId = await greenhouseJob();
    expect((await post(JSON.stringify({ jobId }))).status).toBe(503);
    const [row] = await admin`SELECT status, error_code FROM automation_sessions WHERE user_id = ${USER}`;
    expect(row).toEqual({ status: "failed", error_code: "enqueue_failed" });
  });
});

describe("GET /api/automation-sessions", () => {
  it("returns support, resume availability, the application id and sessions newest first", async () => {
    const jobId = await greenhouseJob();
    await insertGeneratedPdf(admin, USER, jobId, "resume");
    await insertAutomationSession(admin, USER, jobId, { status: "failed" });
    const body = await (await get(`?jobId=${jobId}`)).json();
    expect(body).toMatchObject({ support: { supported: true, portal: "greenhouse" }, resumeAvailable: true, applicationId: null });
    expect(body.sessions).toHaveLength(1);
  });

  it("400s without jobId and 404s an unknown or malformed one", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?jobId=abc")).status).toBe(404);
    expect((await get("?jobId=11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });
});
```

`apps/web/src/app/api/automation-sessions/[id]/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertAutomationSession } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000008a8",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000008a8";
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
const { POST: CANCEL } = await import("./cancel/route");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new Request(`http://localhost/api/automation-sessions/${id}`), ctx(id));
const cancel = (id: string) => CANCEL(new Request(`http://localhost/api/automation-sessions/${id}/cancel`, { method: "POST" }), ctx(id));

describe("/api/automation-sessions/[id]", () => {
  it("returns a session, and 404s unknown or malformed ids", async () => {
    const id = await insertAutomationSession(admin, USER, await insertJob(admin, USER, {}), { status: "awaiting_user" });
    expect((await (await get(id)).json()).session).toMatchObject({ id, status: "awaiting_user" });
    expect((await get("nope")).status).toBe(404);
    expect((await get("11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });

  it("cancels a queued session at once, flags an active one, and 409s an ended one", async () => {
    const jobId = await insertJob(admin, USER, {});
    const queued = await insertAutomationSession(admin, USER, jobId);
    expect((await (await cancel(queued)).json()).session).toMatchObject({ status: "abandoned", errorCode: "cancelled" });
    expect((await cancel(queued)).status).toBe(409);
    const active = await insertAutomationSession(admin, USER, jobId, { status: "filling" });
    expect((await (await cancel(active)).json()).session).toMatchObject({ status: "filling", cancelRequested: true });
    expect((await cancel("11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });
});
```

Append to `describe("POST /api/applications", ...)` in `apps/web/src/app/api/applications/route.test.ts` (and add `insertAutomationSession` to its `jobsDb` import):
```ts
  it("records an application from an autofill session (201) and 409s an unlinkable one", async () => {
    const jobId = await insertJob(admin, USER, {});
    const active = await insertAutomationSession(admin, USER, jobId, { status: "awaiting_user" });
    expect((await post(JSON.stringify({ jobId, automationSessionId: active }))).status).toBe(409);
    const detected = await insertAutomationSession(admin, USER, jobId, { status: "submission_detected" });
    const res = await post(JSON.stringify({ jobId, automationSessionId: detected }));
    expect(res.status).toBe(201);
    const [row] = await admin`SELECT application_id FROM automation_sessions WHERE id = ${detected}`;
    expect(row.application_id).toBe((await res.json()).application.id);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter web test -- automation-sessions serializeSession applications/route`
Expected: FAIL — modules not found; the applications case answers 500 (unmapped `session_not_linkable`).

- [ ] **Step 4: Implement**

`apps/web/src/lib/browser-automation/enqueue.ts`:
```ts
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { BROWSER_JOB_NAME, BROWSER_JOB_OPTIONS, BROWSER_QUEUE_NAME, browserJobId, type BrowserJobData } from "@ai-career/browser";

const ENQUEUE_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 1000;

/** Fixed message on purpose: driver errors carry the Redis host and port, which callers must never echo. */
const unavailable = () => new Error("queue unavailable");

/** Resolves or rejects with `promise`, or rejects with `onTimeout()` after `ms`. The timer never outlives the race. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Put an autofill session on the browser-worker queue. Same fail-fast producer settings as enqueueMatching /
 * enqueueIngestion (see their docstrings). No "already queued" check: the session row's one-active-per-user index
 * already guarantees at most one pending job, and the job id is per session.
 */
export async function enqueueAutofill(env: { REDIS_URL: string }, data: BrowserJobData, queueName: string = BROWSER_QUEUE_NAME): Promise<void> {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000, retryStrategy: () => null });
  const queue = new Queue<BrowserJobData>(queueName, { connection });
  connection.on("error", () => undefined);
  queue.on("error", () => undefined);
  try {
    await withTimeout(
      queue.add(BROWSER_JOB_NAME, data, { ...BROWSER_JOB_OPTIONS, jobId: browserJobId(data.sessionId) }),
      ENQUEUE_TIMEOUT_MS,
      unavailable
    );
  } catch {
    throw unavailable();
  } finally {
    await withTimeout(queue.close(), CLOSE_TIMEOUT_MS, unavailable).catch(() => undefined);
    connection.disconnect();
  }
}
```

`apps/web/src/lib/browser-automation/serializeSession.ts`:
```ts
import type { FieldAuditEntry, SessionRow } from "@ai-career/browser";

export interface SessionView {
  id: string;
  jobId: string;
  status: SessionRow["status"];
  portal: SessionRow["portal"];
  adapterVersion: string;
  formUrl: string;
  fieldAudit: FieldAuditEntry[];
  errorCode: string | null;
  applicationId: string | null;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
  stoppedBeforeSubmit: boolean;
  cancelRequested: boolean;
  submissionDetectedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status,
    portal: row.portal,
    adapterVersion: row.adapterVersion,
    formUrl: row.formUrl,
    fieldAudit: row.fieldAudit as FieldAuditEntry[],
    errorCode: row.errorCode,
    applicationId: row.applicationId,
    resumeDocumentId: row.resumeDocumentId,
    coverLetterDocumentId: row.coverLetterDocumentId,
    stoppedBeforeSubmit: row.stoppedBeforeSubmit,
    cancelRequested: row.cancelRequestedAt !== null,
    submissionDetectedAt: iso(row.submissionDetectedAt),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    createdAt: row.createdAt.toISOString(),
  };
}
```

`apps/web/src/lib/browser-automation/errorResponse.ts`:
```ts
import { NextResponse } from "next/server";
import { AutomationError } from "@ai-career/browser";

/** Maps a domain error class to its HTTP answer; null means "not ours, rethrow". */
export function automationErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof AutomationError)) return null;
  switch (error.errorClass) {
    case "job_not_found":
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    case "not_found":
      return NextResponse.json({ error: "Autofill session not found" }, { status: 404 });
    case "profile_missing":
      return NextResponse.json({ error: "Create your candidate profile first" }, { status: 409 });
    case "session_active":
      return NextResponse.json({ error: "An autofill session is already running. Finish or cancel it first." }, { status: 409 });
    case "not_cancellable":
      return NextResponse.json({ error: "This autofill session has already ended" }, { status: 409 });
    case "unsupported":
      return NextResponse.json({ error: "Autofill is not supported for this job", reason: error.detail }, { status: 422 });
  }
}
```

Add to the `switch` in `apps/web/src/lib/applications/errorResponse.ts`:
```ts
    case "session_not_linkable":
      return NextResponse.json({ error: "This autofill session cannot be linked to an application" }, { status: 409 });
```

`apps/web/src/app/api/automation-sessions/route.ts`:
```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createSession, failSession, getJobAutofillOverview } from "@ai-career/browser";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { enqueueAutofill } from "../../../lib/browser-automation/enqueue";
import { toSessionView } from "../../../lib/browser-automation/serializeSession";
import { automationErrorResponse } from "../../../lib/browser-automation/errorResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CreateBodySchema = z.object({ jobId: z.string().uuid() }).strict();
const jobNotFound = () => NextResponse.json({ error: "Job not found" }, { status: 404 });

/** Everything AutofillPanel renders, in one request (design §6). */
export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (jobId === null) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  if (!UUID_RE.test(jobId)) return jobNotFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const overview = await getJobAutofillOverview(db, env.DEFAULT_USER_ID, jobId);
    if (!overview) return jobNotFound();
    return NextResponse.json({ ...overview, sessions: overview.sessions.map(toSessionView) });
  } finally {
    await closeDbClient(db);
  }
}

export async function POST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = CreateBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const session = await createSession(db, env.DEFAULT_USER_ID, parsed.data.jobId);
    try {
      await enqueueAutofill(env, { sessionId: session.id, userId: env.DEFAULT_USER_ID });
    } catch {
      await failSession(db, env.DEFAULT_USER_ID, session.id, "enqueue_failed");
      return NextResponse.json({ error: "The browser worker queue is unavailable. Is Redis running?" }, { status: 503 });
    }
    return NextResponse.json({ session: toSessionView(session) }, { status: 201 });
  } catch (error) {
    const mapped = automationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
```

`apps/web/src/app/api/automation-sessions/[id]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { getSession } from "@ai-career/browser";
import { toSessionView } from "../../../../lib/browser-automation/serializeSession";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Autofill session not found" }, { status: 404 });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await getSession(db, env.DEFAULT_USER_ID, id);
    return row ? NextResponse.json({ session: toSessionView(row) }) : notFound();
  } finally {
    await closeDbClient(db);
  }
}
```

`apps/web/src/app/api/automation-sessions/[id]/cancel/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { requestCancel } from "@ai-career/browser";
import { toSessionView } from "../../../../../lib/browser-automation/serializeSession";
import { automationErrorResponse } from "../../../../../lib/browser-automation/errorResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Autofill session not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await requestCancel(db, env.DEFAULT_USER_ID, id);
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    const mapped = automationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 5: Run the tests, typecheck and lint**

Run: `pnpm --filter web test -- automation-sessions serializeSession applications && pnpm --filter web typecheck && pnpm --filter web lint`
Expected: PASS. `apps/web` must not import `playwright-core` anywhere: `grep -rn "playwright" apps/web/src` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): automation session routes (create+enqueue, overview, get, cancel) and session-linked applications"
```

---

### Task 10: `AutofillPanel` on the match page

**Files:**
- Create: `apps/web/src/app/matches/[jobId]/AutofillPanel.tsx`
- Modify: `apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx`, `apps/web/src/app/matches/[jobId]/ApplicationPanel.tsx`
- Test: `apps/web/src/app/matches/[jobId]/AutofillPanel.test.tsx`; modify `MatchDetailClient.test.tsx`, `ApplicationPanel.test.tsx`

**Interfaces:**
- Consumes: Task 9 routes and `SessionView` shape; `POST /api/applications {jobId, automationSessionId}`.
- Produces: `AutofillPanel({ jobId })`, `APPLICATION_RECORDED_EVENT = "application:recorded"` (window event; ApplicationPanel reloads on it).

- [ ] **Step 1: Write the failing tests**

`apps/web/src/app/matches/[jobId]/AutofillPanel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AutofillPanel, APPLICATION_RECORDED_EVENT } from "./AutofillPanel";

beforeEach(() => vi.unstubAllGlobals());

const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => body } as Response);
const session = (over: Record<string, unknown> = {}) => ({
  id: "s1", jobId: "j1", status: "awaiting_user", portal: "greenhouse", formUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
  errorCode: null, applicationId: null, cancelRequested: false, createdAt: new Date().toISOString(),
  fieldAudit: [
    { key: "f0", label: "Email", required: true, canonical: "email", action: "filled", reason: null, valueSource: "profile.email", verified: true },
    { key: "f1", label: "Phone", required: false, canonical: "phone", action: "flagged", reason: "verify_mismatch", valueSource: "profile.phoneNumber", verified: false },
    { key: "f2", label: "Will you require sponsorship?", required: true, canonical: "sponsorship", action: "flagged", reason: "unsupported_control", valueSource: null, verified: null },
    { key: "f3", label: "Gender", required: false, canonical: "eeo", action: "skipped", reason: "intentionally_not_filled", valueSource: null, verified: null },
  ],
  ...over,
});
const overview = (over: Record<string, unknown> = {}) => ({
  support: { supported: true, portal: "greenhouse", adapterVersion: "greenhouse-v1", formUrl: "https://job-boards.greenhouse.io/acme/jobs/1" },
  resumeAvailable: true, applicationId: null, sessions: [], ...over,
});

describe("AutofillPanel", () => {
  it("explains why autofill is unavailable for an unsupported job", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ support: { supported: false, reason: "no_supported_posting" } }))));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/only available for jobs from a Greenhouse or Lever source/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /autofill/i })).not.toBeInTheDocument();
  });

  it("disables the button until a resume PDF exists", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ resumeAvailable: false }))));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByRole("button", { name: "Open & autofill application (Greenhouse)" })).toBeDisabled();
    expect(screen.getByText(/export a resume pdf for this job first/i)).toBeInTheDocument();
  });

  it("starts a session and shows the audit with flagged fields first", async () => {
    let started = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        started = true;
        return json({ session: session({ status: "queued", fieldAudit: [] }) }, true, 201);
      }
      return json(overview({ sessions: started ? [session()] : [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutofillPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open & autofill application (Greenhouse)" }));
    await screen.findByText("Waiting for you in the browser window");
    expect(fetchMock).toHaveBeenCalledWith("/api/automation-sessions", expect.objectContaining({ method: "POST", body: JSON.stringify({ jobId: "j1" }) }));
    const lists = screen.getAllByRole("list");
    expect(within(lists[0]).getByText(/Will you require sponsorship\?/)).toBeInTheDocument();
    expect(screen.getByText(/complete these in the browser window, then click submit yourself/i)).toBeInTheDocument();
    expect(screen.getByText(/value did not stick/i)).toBeInTheDocument();
    expect(screen.getByText(/intentionally not filled/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open & autofill application (Greenhouse)" })).toBeDisabled();
  });

  it("cancels the active session", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ session: session({ status: "abandoned" }) }) : json(overview({ sessions: [session()] }))
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AutofillPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/automation-sessions/s1/cancel", { method: "POST" }));
  });

  it("records a detected submission as applied and announces it", async () => {
    const listener = vi.fn();
    window.addEventListener(APPLICATION_RECORDED_EVENT, listener);
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ application: { id: "a1" } }, true, 201)
        : json(overview({ sessions: [session({ status: "submission_detected" })] }))
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/looks like you submitted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record as applied" }));
    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/applications", expect.objectContaining({
      method: "POST", body: JSON.stringify({ jobId: "j1", automationSessionId: "s1" }),
    }));
    window.removeEventListener(APPLICATION_RECORDED_EVENT, listener);
  });

  it("offers recording after an abandoned session but not once an application exists", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ sessions: [session({ status: "abandoned", errorCode: "window_closed" })] }))));
    const { unmount } = render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/did you submit anyway/i)).toBeInTheDocument();
    unmount();
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ applicationId: "a1", sessions: [session({ status: "submission_detected" })] }))));
    render(<AutofillPanel jobId="j1" />);
    await screen.findByText("Submission detected");
    expect(screen.queryByRole("button", { name: "Record as applied" })).not.toBeInTheDocument();
  });

  it("explains a needs-manual session and links the form", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ sessions: [session({ status: "needs_manual", errorCode: "health_check_failed", fieldAudit: [] })] }))));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/did not look like the known/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the form yourself/i })).toHaveAttribute("href", "https://job-boards.greenhouse.io/acme/jobs/1");
  });

  it("shows a load error for a malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ unexpected: true })));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
  });
});
```

In `apps/web/src/app/matches/[jobId]/MatchDetailClient.test.tsx`, add a branch to `mockFetch` before the final fallback:
```ts
      if (url.includes("/api/automation-sessions")) {
        return { ok: true, status: 200, json: async () => ({ support: { supported: false, reason: "no_supported_posting" }, resumeAvailable: false, applicationId: null, sessions: [] }) } as Response;
      }
```
and, in its eligible-match test, assert: `expect(await screen.findByRole("heading", { name: "Application autofill", exact: true })).toBeInTheDocument();`

In `apps/web/src/app/matches/[jobId]/ApplicationPanel.test.tsx` add (importing `APPLICATION_RECORDED_EVENT` from `./AutofillPanel` and `act` from `@testing-library/react`):
```tsx
  it("reloads when an autofill session is recorded as applied", async () => {
    const fetchMock = vi.fn(() => json({ application: null, documentOptions: options }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationPanel jobId="j1" />);
    await screen.findByRole("button", { name: "Mark as applied" });
    const before = fetchMock.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event(APPLICATION_RECORDED_EVENT));
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test -- AutofillPanel MatchDetailClient ApplicationPanel`
Expected: FAIL — `./AutofillPanel` not found.

- [ ] **Step 3: Implement the panel**

`apps/web/src/app/matches/[jobId]/AutofillPanel.tsx`:
```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

/** Dispatched after "Record as applied" so ApplicationPanel reloads (Phase 8). */
export const APPLICATION_RECORDED_EVENT = "application:recorded";

type Status = "queued" | "launching" | "filling" | "awaiting_user" | "submission_detected" | "abandoned" | "needs_manual" | "failed";
interface AuditEntry {
  key: string;
  label: string | null;
  required: boolean;
  canonical: string | null;
  action: "filled" | "flagged" | "skipped";
  reason: string | null;
  verified: boolean | null;
}
interface SessionView {
  id: string;
  status: Status;
  portal: "greenhouse" | "lever";
  formUrl: string;
  errorCode: string | null;
  fieldAudit: AuditEntry[];
  createdAt: string;
}
interface Overview {
  support: { supported: true; portal: "greenhouse" | "lever" } | { supported: false; reason: string };
  resumeAvailable: boolean;
  applicationId: string | null;
  sessions: SessionView[];
}

const ACTIVE = new Set<Status>(["queued", "launching", "filling", "awaiting_user"]);
const POLL_MS = 2000;
const QUEUED_HINT_AFTER_MS = 10_000;
const PORTAL_NAME = { greenhouse: "Greenhouse", lever: "Lever" } as const;
const STATUS_TEXT: Record<Status, string> = {
  queued: "Queued",
  launching: "Opening the browser...",
  filling: "Filling the form...",
  awaiting_user: "Waiting for you in the browser window",
  submission_detected: "Submission detected",
  abandoned: "Ended without a detected submission",
  needs_manual: "Needs manual completion",
  failed: "Failed",
};
const UNSUPPORTED_TEXT: Record<string, string> = {
  no_supported_posting: "Autofill is only available for jobs from a Greenhouse or Lever source.",
  invalid_identifiers: "This posting's board or job id cannot be used to build a form address.",
};
const ERROR_TEXT: Record<string, string> = {
  health_check_failed: "The page did not look like the known Greenhouse/Lever form, so nothing was filled.",
  navigation_failed: "The application page could not be loaded.",
  off_host_redirect: "The page redirected away from the application site, so nothing was filled.",
  form_url_not_allowed: "The form address is not on an allowed application site.",
  browser_launch_failed: "Chrome could not be started. Is Google Chrome installed?",
  worker_restart: "The browser worker restarted during this session.",
  enqueue_failed: "The session could not be queued.",
  unexpected_error: "Something went wrong during autofill.",
  cancelled: "Cancelled.",
  timeout: "The window timed out and was closed.",
  window_closed: "The browser window was closed.",
};
const REASON_TEXT: Record<string, string> = {
  unrecognized: "Not recognized",
  ambiguous_match: "More than one field looked like this one",
  no_value: "No value in your profile",
  no_resume_export: "Export a resume PDF for this job first",
  attachment_unavailable: "The file could not be loaded",
  autocomplete_widget: "Pick from the site's suggestions",
  unsupported_control: "Needs a choice in the site's dropdown",
  unrecognized_options: "Unexpected answer options",
  not_auto_filled: "Not filled automatically",
  intentionally_not_filled: "Intentionally not filled (equal-opportunity question)",
  verify_mismatch: "Value did not stick, check it",
  fill_error: "Could not be filled",
  guard_blocked: "Blocked by the safety guard",
};

const isOverview = (v: unknown): v is Overview =>
  typeof v === "object" && v !== null && "support" in v && Array.isArray((v as Overview).sessions);
const fieldName = (a: AuditEntry) => a.label ?? a.canonical ?? "Unnamed field";

function AuditList({ title, entries }: { title: string; entries: AuditEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="list-disc pl-5 text-sm">
        {entries.map((a) => (
          <li key={a.key}>
            {fieldName(a)}
            {a.action === "filled" && a.verified !== false && " ✓"}
            {a.reason && <span className="text-gray-600"> — {REASON_TEXT[a.reason] ?? a.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Phase 8 design §7. Starts an autofill session, polls it while active, shows the field audit, and offers the
 * one-click "Record as applied" (spec §11.8). The user always submits in the browser window themselves.
 */
export function AutofillPanel({ jobId }: { jobId: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/automation-sessions?jobId=${encodeURIComponent(jobId)}`);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok || !isOverview(body)) throw new Error("load failed");
    setOverview(body);
    setLoadError(false);
  }, [jobId]);

  useEffect(() => {
    load().catch(() => setLoadError(true));
  }, [load]);

  const latest = overview?.sessions[0] ?? null;
  const active = latest !== null && ACTIVE.has(latest.status);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load().catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const post = async (url: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, body === undefined ? { method: "POST" } : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) setError(typeof result.error === "string" ? result.error : "The request failed.");
      return res.ok;
    } catch {
      setError("The request failed.");
      return false;
    } finally {
      setBusy(false);
      await load().catch(() => undefined);
    }
  };

  const start = () => post("/api/automation-sessions", { jobId });
  const cancel = (id: string) => post(`/api/automation-sessions/${encodeURIComponent(id)}/cancel`);
  const record = async (id: string) => {
    if (await post("/api/applications", { jobId, automationSessionId: id })) window.dispatchEvent(new Event(APPLICATION_RECORDED_EVENT));
  };

  const audit = latest?.fieldAudit ?? [];
  const canRecord = latest !== null && overview?.applicationId === null && (latest.status === "submission_detected" || latest.status === "abandoned");
  const queuedLong = latest?.status === "queued" && Date.now() - new Date(latest.createdAt).getTime() > QUEUED_HINT_AFTER_MS;

  return (
    <section aria-labelledby="autofill-heading" className="flex flex-col gap-2 rounded border p-4">
      <h2 id="autofill-heading" className="font-medium">Application autofill</h2>
      {overview === null && !loadError && <p className="text-sm text-gray-600">Loading...</p>}
      {loadError && <p role="alert" className="text-sm text-red-600">Could not load the autofill status.</p>}
      {overview && !overview.support.supported && (
        <p className="text-sm text-gray-600">{UNSUPPORTED_TEXT[overview.support.reason] ?? "Autofill is not supported for this job."}</p>
      )}
      {overview && overview.support.supported && (
        <>
          <p className="text-sm text-gray-600">
            Chrome opens on this computer with the form filled where possible. Review every field and click Submit yourself; CareerPilot never submits.
          </p>
          <button type="button" onClick={() => void start()} disabled={busy || active || !overview.resumeAvailable}
            className="self-start rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">
            Open &amp; autofill application ({PORTAL_NAME[overview.support.portal]})
          </button>
          {!overview.resumeAvailable && <p className="text-sm text-gray-600">Export a resume PDF for this job first (use the download buttons).</p>}
        </>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {latest && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-sm">
            <p>{STATUS_TEXT[latest.status]}</p>
            {active && (
              <button type="button" onClick={() => void cancel(latest.id)} disabled={busy} className="rounded border px-2 py-0.5">Cancel</button>
            )}
          </div>
          {queuedLong && (
            <p className="text-sm text-gray-600">Still queued. Is the browser worker running? Start it with <code>pnpm --filter @ai-career/browser-worker start</code>.</p>
          )}
          {latest.errorCode && !active && <p className="text-sm text-gray-600">{ERROR_TEXT[latest.errorCode] ?? latest.errorCode}</p>}
          {(latest.status === "needs_manual" || latest.status === "failed") && (
            <a href={latest.formUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">Open the form yourself</a>
          )}
          {canRecord && latest.status === "submission_detected" && (
            <div className="flex items-center gap-3 rounded bg-green-50 p-2 text-sm">
              <p>Looks like you submitted. Record as applied?</p>
              <button type="button" onClick={() => void record(latest.id)} disabled={busy} className="rounded bg-black px-2 py-0.5 text-white">Record as applied</button>
            </div>
          )}
          {canRecord && latest.status === "abandoned" && (
            <div className="flex items-center gap-3 text-sm">
              <p>Did you submit anyway?</p>
              <button type="button" onClick={() => void record(latest.id)} disabled={busy} className="rounded border px-2 py-0.5">Record as applied</button>
            </div>
          )}
          <AuditList title="Complete these in the browser window, then click Submit yourself" entries={audit.filter((a) => a.action === "flagged")} />
          <AuditList title="Filled" entries={audit.filter((a) => a.action === "filled")} />
          <AuditList title="Not filled" entries={audit.filter((a) => a.action === "skipped")} />
        </div>
      )}

      {overview && overview.sessions.length > 1 && (
        <details className="text-sm">
          <summary>Earlier sessions</summary>
          <ul className="pl-5">
            {overview.sessions.slice(1).map((s) => (
              <li key={s.id}>{new Date(s.createdAt).toLocaleString()} · {STATUS_TEXT[s.status]}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
```

In `MatchDetailClient.tsx`: import `{ AutofillPanel } from "./AutofillPanel"` and render `{showWorkspace && <AutofillPanel jobId={jobId} />}` directly after `<ApplicationPanel jobId={jobId} />`.

In `ApplicationPanel.tsx`: import `{ APPLICATION_RECORDED_EVENT } from "./AutofillPanel"`, and in the effect add `window.addEventListener(APPLICATION_RECORDED_EVENT, load);` with the matching `removeEventListener` in the cleanup, next to the `DOCUMENTS_CHANGED_EVENT` lines. Update the comment above the effect to mention it.

- [ ] **Step 4: Run the web suite, typecheck, lint and build**

Run: `pnpm --filter web test && pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build`
Expected: all PASS; the build succeeds (no Playwright reaches the web bundle).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): AutofillPanel with live status, field audit, cancel and one-click record-as-applied"
```

---

### Task 11: Documentation

**Files:**
- Modify: `DECISIONS.md`, `FLOW.md`, `docs/architecture.md`, `README.md`, `.env.example`, `LEGAL.md`, `docs/superpowers/specs/2026-10-01-phase-8-browser-automation-design.md`

- [ ] **Step 1: DECISIONS.md**

Under D4's heading add the line `**Status:** Superseded by D127 (2026-10-01).` Then append, after checking the next free number (`grep -n "^### D1[2-9][0-9]" DECISIONS.md | tail -1`; expected D127), entries in the file's existing format (**Decision / Alternatives considered / Why / What it affects**):
- **D127** Guarded Playwright autofill supersedes D4's Auto-Prep (user choice in brainstorming; D4's safeguards kept: versioned adapters, health check → manual, structural stop-before-submit).
- **D128** Form URLs built from the source slug + posting external id; Greenhouse/Lever hosted forms only; navigation host allowlist; `SAFE_IDENTIFIER`.
- **D129** Deterministic classification; standard + two rule-based answers (sponsorship, salary target); combobox widgets never filled — so Greenhouse yes/no questions are always flagged; Lever location flagged; the "flagged when required, skipped when optional" rule.
- **D130** Stop-before-submit is structural: four guarded primitives in `actions.ts`, `check` only on radio/checkbox inputs, the no-click source test.
- **D131** Snapshot extractor as a plain-JS string (tsx `keepNames` / `__name`), `data-cp-key` addressing, jsdom tests on sanitized live forms.
- **D132** Host-only worker; throwaway profile + attachments share one temp root deleted on close (Chrome reads file inputs at submit time); released windows for `needs_manual`/`submission_detected`; concurrency 1 + one-active-session index.
- **D133** Startup sweep excludes `queued`; queued sessions wait for the worker; cancel abandons queued rows directly under `FOR UPDATE`.
- **D134** Detection by 1 s polling (URL path patterns, thanks text away from the form URL, same host only) — a hint only.
- **D135** One-click "Record as applied" with `automationSessionId`; documents default to the attached files' sources; linked in the same transaction.
- **D136** Field audit stores value sources, never values; logs carry ids/statuses/error codes only.

- [ ] **Step 2: FLOW.md**

Add `## 13. Phase 8 — Browser Automation (Guarded Autofill)` after §12 with subsections, each listing the exact files and call order:
- 13a Start (request-driven): `AutofillPanel.start` → `POST /api/automation-sessions` → `createSession` (job, profile, `getAutofillSupport` → `resolveAutofillTarget` → adapter `buildFormUrl`, insert `queued`) → `enqueueAutofill` (→ on failure `failSession(enqueue_failed)`, 503).
- 13b Worker run: `main.ts` (`sweepInterruptedSessions`) → `createBrowserWorker` → `runSession`: claim `queued→launching` → host check → `loadAutofillContext` → `downloadAttachments` → `launchBrowser` → `launching→filling` → `goto` + host check → `takeSnapshot` (`EXTRACT_SNAPSHOT_SOURCE`) → `buildAutofillValues` → `buildFillPlan` (`classifyField`) → `performAction`/`verifyAction` per action → `filling→awaiting_user` → poll loop (`isClosed`, timeout, `isCancelRequested`, `readPageText` + `detectSubmission`) → end/release.
- 13c Polling and cancel: `GET /api/automation-sessions?jobId` → `getJobAutofillOverview`; `POST …/[id]/cancel` → `requestCancel`.
- 13d Record as applied: `AutofillPanel.record` → `POST /api/applications {jobId, automationSessionId}` → `createApplication` → `lockLinkableSession` → `withSessionDocuments` → `loadLinkedDocuments` → insert → link session → `APPLICATION_RECORDED_EVENT` → `ApplicationPanel` reload.
- "Changing Phase 8 behavior": where to add a portal (new adapter + fixture + tests), where classification rules live, and that `actions.ts` is the only Playwright-mutating module.

- [ ] **Step 3: architecture.md, README, .env.example, LEGAL.md, spec**

- `docs/architecture.md`: update the status line (Phases 0–9 implemented); rewrite §6 as "Application automation — guarded autofill (D127)" describing the as-built flow (replace the Auto-Prep diagram); add a §18 "Phase 8 as built" summary (package/service/table/routes/UI, the never-filled categories, the released-window model).
- `README.md`: replace the "Browser automation (Phase 8) is deferred" paragraph with a "Browser autofill" section: prerequisites (Google Chrome installed), `pnpm --filter @ai-career/browser-worker start` on the host (not in Docker), what gets filled/flagged, that you always click Submit yourself, the three `BROWSER_*` variables.
- `.env.example`: add commented `# BROWSER_EXECUTABLE_PATH=`, `# BROWSER_HEADLESS=false`, `# BROWSER_SESSION_TIMEOUT_MIN=30` with one-line explanations, after `RETENTION_DAYS`.
- `LEGAL.md`: add a short "Browser autofill" note — it only fills public hosted application forms you open yourself, never submits, never solves CAPTCHAs; you are responsible for complying with each site's terms.
- Spec: set `Status:` to "Implemented on branch `<branch>` (2026-10-01); see §12 for post-implementation notes." and add `## 12. Post-implementation notes` listing any deviation found during Tasks 1–10 (write "None" if there were none).

- [ ] **Step 4: Check and commit**

Run: `grep -n "Phase 8 (browser automation) is deferred\|Phase 8 .*deferred" README.md docs/architecture.md` — Expected: no hits (the deferred notes in the Phase 9 spec and D112 are historical and stay).
```bash
git add DECISIONS.md FLOW.md docs README.md .env.example LEGAL.md
git commit -m "docs: Phase 8 browser automation (D127-D136, FLOW §13, architecture §6/§18, README, LEGAL)"
```

---

### Task 12: Full verification and live E2E (stop before Submit)

**Files:**
- Modify: `DECISIONS.md` (one verification entry, next free number after Task 11's)
- Scratch only (not committed): an E2E seed script and a playwright-core driver in the session scratchpad.

- [ ] **Step 1: CI-order checks from the repo root**

Run, in order: `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test`.
Expected: all green. Re-run `pnpm test -- --force` once more to catch shared-test-DB contention (a different file failing on each run means a test-user-id collision: grep the whole repo for the ids in Global Constraints).

- [ ] **Step 2: Seed a synthetic user in `career_intel_test` against live postings**

Fetch one open job from a public Greenhouse board and one from a public Lever board:
```bash
curl -s "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs" | python3 -c "import json,sys; j=json.load(sys.stdin)['jobs'][0]; print(j['id'])"
curl -s "https://api.lever.co/v0/postings/palantir?mode=json&limit=1" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])"
```
With user `00000000-0000-0000-0000-0000000008b1`, insert via admin SQL into `career_intel_test`: a `candidate_profiles` row (synthetic name/email/phone/LinkedIn — not real personal data), an active confirmed `career_goals` + `career_goal_constraints` row (`visa_sponsorship_required = false`), and for each portal: a `jobs` row, a `job_sources` row (`kind` greenhouse/lever, `config = {"slug": "gitlab"|"palantir"}`), an open `job_postings` row with the fetched external id, an eligible `job_matches` row (same columns as `apps/web/src/test/jobsDb.ts` `insertMatch`), and a resume PDF: upload any small PDF to MinIO bucket `generated-documents` at key `00000000-0000-0000-0000-0000000008b1/e2e-resume.pdf` and insert a matching `generated_documents` row (kind `resume`, format `pdf`).

- [ ] **Step 3: Run the real app and the real worker, headed**

```bash
pnpm --filter web build
DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test DEFAULT_USER_ID=00000000-0000-0000-0000-0000000008b1 pnpm --filter web start
DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test DEFAULT_USER_ID=00000000-0000-0000-0000-0000000008b1 BROWSER_SESSION_TIMEOUT_MIN=5 pnpm --filter @ai-career/browser-worker start
```
For each portal, drive `/matches/<jobId>` with playwright-core (system Chrome, from the scratchpad) or by hand:
1. Click "Open & autofill application (…)". A second, visible Chrome window opens on the live form.
2. Confirm in that window: name/email/phone/LinkedIn filled, resume attached (Lever: sponsorship "No" selected), nothing submitted.
3. Confirm the panel shows "Waiting for you in the browser window" and an audit whose flagged list matches what is visibly empty in the form.
4. **Do not click Submit.** Close the window. The panel shows "Ended without a detected submission" and "Did you submit anyway?".
5. Click "Record as applied" → the Application panel switches to "Applied on …", and `SELECT application_id FROM automation_sessions` is set.
6. Also click Cancel on a second session while it is awaiting the user, and confirm the window closes and the status is `abandoned`/`cancelled`.

If a live form fails the health check (`needs_manual`), compare its markup with the fixture, update the adapter and the fixture together (bump the adapter version, e.g. `greenhouse-v2`, if rules change), and re-run Tasks 3–7's tests.

- [ ] **Step 4: Clean up and record**

Delete the synthetic user's rows (`applications`, `jobs`, `job_sources`, `career_goals`, `candidate_profiles` for `…08b1`) and its MinIO object. Append a DECISIONS entry "Phase 8 verification": the CI-order results, the live portals and posting ids used, what was filled/flagged on each live form, that Submit was never clicked, and any adapter changes made. Then:
```bash
git add DECISIONS.md
git commit -m "docs: Phase 8 verification (CI-order checks, live Greenhouse/Lever E2E stopping before submit)"
```
