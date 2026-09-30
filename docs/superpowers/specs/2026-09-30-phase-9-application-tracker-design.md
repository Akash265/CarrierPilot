# Phase 9 — Application Tracker: Design

Date: 2026-09-30
Status: Approved in brainstorming (sections 1–3), pending written-spec review
Spec sources: project spec §14 (Application Tracker & Feedback Loop), §16 (Rejection & Re-optimization Loop), §19 (tables), §21 (Phase 9); architecture.md §9 (retention).

## 1. Scope

Phase 9 builds the application tracker: lifecycle state, association of the documents actually sent, follow-ups, recruiter/interview events, outcomes, and the 30-day retention sweep that earlier phases deferred to it.

**Phase 8 (browser automation) is deferred and not built.** Applications are therefore recorded by the user ("Mark as applied" / "Add external application"), not by an automation session. Phase 8's `automation_sessions` can later link into `applications` without changing this design.

In scope:
- `applications` and `application_events` tables (+ RLS).
- A new domain package `packages/applications`.
- API routes under `/api/applications`.
- UI: "Mark as applied" panel on `/matches/[jobId]`, new `/applications` list and `/applications/[id]` detail pages, home-nav entry.
- "Already applied" as a deterministic eligibility exclusion in matching (Phase 5 carried gap).
- A retention sweep in a new `services/maintenance-worker`, plus a manual `pnpm retention:run`, including the orphaned-MinIO-object sweep (Phase 7b carried gap).

Out of scope:
- Notifications (in-app or outbound), analytics, outcome-learning/prediction (Phase 10).
- Browser automation (Phase 8).
- A recruiter/contacts table; email ingestion of recruiter messages.
- An `application_outcomes` table (see decision 7).

## 2. Decisions taken in brainstorming

1. **Applications can be ingested or external.** `job_id` is nullable; external applications carry typed-in company/title/URL. Every application is on the tracker, the "central dashboard" of spec §14.
2. **Permissive lifecycle.** Any status may move to any other status; every change is logged as an event. Terminal states start the retention clock; reopening stops it (unless already purged).
3. **Retention deletes files and job-specific generated text** 30 days (`RETENTION_DAYS`) after a terminal status. The application, its events and its feature snapshot stay. The base profile/resume is never touched.
4. **Follow-ups are in-app only:** a `follow_up_at` date and a "Follow-ups due" section, with done/snooze events. No notification system.
5. **Code layout:** new `packages/applications` domain package; Next.js routes are thin; the sweep runs as a daily BullMQ job scheduler in a new `services/maintenance-worker`.
6. **"Already applied" is computed at match time** by joining `applications`, not stored on the job. Applied jobs leave the ranked feed and show in the ineligible list with the reason "already applied"; deleting the application brings them back.
7. **No `application_outcomes` table yet.** The outcome is the terminal status plus its `status_change` event; Phase 10 can derive a view. This deviates from spec §19 and is logged in DECISIONS.md.
8. **Recruiter details are minimal:** optional free-text `recruiter_name` / `recruiter_contact` on the application, and `recruiter_contact` events. Existing log-scrubbing rules apply.

## 3. Data model

Migration `0024` (tables) and `0025` (RLS), following the existing pattern: every row carries `user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid`, RLS enabled with the standard policy.

### `applications`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS |
| `job_id` | uuid null → `jobs.id` ON DELETE SET NULL | Null for external applications, or after the job is deleted. |
| `company_name` | text not null | Copied from the job at creation, or typed in. Max 200. |
| `job_title` | text not null | Copied or typed. Max 300. |
| `job_url` | text null | Copied or typed; must be http(s). Max 2000. |
| `status` | enum `application_status` not null | `applied`, `screening`, `interviewing`, `offer`, `accepted`, `declined`, `rejected`, `withdrawn`, `no_response`. |
| `status_changed_at` | timestamptz not null | |
| `applied_at` | date not null | Defaults to today; editable. |
| `follow_up_at` | date null | |
| `recruiter_name` | text null | Max 200. |
| `recruiter_contact` | text null | Max 300. |
| `salary_notes` | text null | Max 500. Free text; never parsed by an LLM (D6). |
| `notes` | text null | Max 5000. |
| `resume_optimization_id` | uuid null → ON DELETE SET NULL | Resume version actually sent. |
| `application_pitch_id` | uuid null → ON DELETE SET NULL | Pitch version actually sent. |
| `cover_letter_id` | uuid null → ON DELETE SET NULL | Cover letter version actually sent. |
| `feature_snapshot` | jsonb not null | Written once at creation, never updated. CHECK `jsonb_typeof = 'object'`. |
| `terminal_at` | timestamptz null | Set when status becomes terminal, cleared on reopen. The retention clock. |
| `retention_purged_at` | timestamptz null | Set once the sweep deletes this job's generated data. |
| `created_at`, `updated_at` | timestamptz | |

Constraints and indexes:
- Partial unique index `(user_id, job_id) WHERE job_id IS NOT NULL`: one application per ingested job.
- CHECK: `terminal_at IS NULL` exactly when status is non-terminal. Terminal statuses are `accepted`, `declined`, `rejected`, `withdrawn`, `no_response`.
- Index on `(user_id, follow_up_at)` for the due list, and `(user_id, status)`.
- Interview preparation is not linked, because it is a preparation document rather than something sent.
- A linked document must belong to the same `job_id`. This is enforced in the domain layer (422), because a CHECK constraint cannot reference other tables.

**`feature_snapshot`** (`snapshotVersion: 1`) is built server-side at creation from whatever exists at that moment. Missing parts are `null`, never zero:
- `match`: `careerGoalId`, `overallScore`, the nine factor scores, `computedAt`, or null.
- `ats`: `overallScore`, `requiredKeywordCoverage`, `preferredKeywordCoverage`, `semanticSimilarity`, or null.
- `documents`: `{ resume, pitch, coverLetter }`, each `{ id, version, origin, sourceProfileContentHash }` or null. `origin` (generated / user_edited) applies to pitch and cover letter only. These survive retention even though the rows they name are deleted.
- `job`: `title`, `companyName`, `seniority`, `countryCode`, `locationRaw`, `workMode`, `employmentType`, `salaryMin`, `salaryMax`, `salaryCurrency`, `salaryPeriod`, `sponsorship`, `postingAgeDays` (from `postedAt` or else `firstSeenAt`, relative to `applied_at`).
- `external`: true when there is no `job_id`. Then `job` holds only company/title, and `match`/`ats`/`documents` are null.

### `application_events`

Append-only. The application code has no update or delete path, and only the `applications` cascade removes rows.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS |
| `application_id` | uuid not null → ON DELETE CASCADE | |
| `type` | enum `application_event_type` | `status_change`, `note`, `recruiter_contact`, `interview`, `follow_up_done`, `follow_up_snoozed`, `documents_purged`. |
| `occurred_at` | timestamptz not null | User may backdate. May not be in the future, except `interview`, which may be scheduled ahead. |
| `from_status`, `to_status` | enum null | Required for `status_change` (CHECK), null otherwise. |
| `detail` | jsonb not null default `{}` | Validated per type with Zod (§4.2). |
| `created_at` | timestamptz | |

Index on `(application_id, occurred_at)`.

### Unchanged

`job_matches.user_action` (saved/dismissed) is unchanged. No `application_outcomes` or `notifications` tables are created.

## 4. Domain package `packages/applications`

Pure modules (no DB) plus thin DB operations, mirroring `application-package`.

### 4.1 Status rules (`status.ts`)
- `TERMINAL_STATUSES`, `isTerminal(status)`.
- `planStatusChange({ current, to, now, occurredAt })` → `{ status, statusChangedAt, terminalAt }` or a `SameStatus` error.
  - Moving to a terminal status sets `terminalAt = now`, **not** `occurredAt`. A backdated rejection must not start deletion immediately; the user gets the full retention period from the moment they record it. `statusChangedAt` uses `occurredAt ?? now` for display.
  - Moving to a non-terminal status sets `terminalAt = null`.
  - Moving from one terminal status to another keeps the original `terminalAt`, so the clock does not restart.

### 4.2 Event schemas (`events.ts`)
Zod discriminated union on `type`:
- `note`: `{ text: 1..5000 }`
- `recruiter_contact`: `{ channel: "email"|"phone"|"linkedin"|"other", summary: 0..2000 }`
- `interview`: `{ round: 1..20?, kind: "phone_screen"|"technical"|"behavioral"|"onsite"|"panel"|"other", scheduledFor?: iso datetime, summary: 0..2000 }`
- `follow_up_done`: `{}`
- `follow_up_snoozed`: `{ newFollowUpAt: date }`
- `status_change` and `documents_purged` are system-written only and cannot be posted through the events route.

### 4.3 Snapshot builder (`snapshot.ts`)
`buildFeatureSnapshot({ job, match, ats, documents, appliedAt, external })` is a pure function returning the §3 shape.

### 4.4 DB operations (`repository.ts`)
All run under the existing `withUser` / `app.current_user_id` pattern.
- `createApplication`:
  1. Load the job, its match, the chosen documents and their ATS evaluation.
  2. Verify every chosen document's `job_id` matches (422 otherwise).
  3. Build the snapshot.
  4. Insert the application and its initial `status_change` event (`from=null`, `to=applied`) in one transaction.

  A unique violation on `(user_id, job_id)` becomes `AlreadyApplied` (409). Defaults for the document choice are chosen by the UI (latest version of each); the server stores only what it is sent.
- `changeStatus`: in one transaction, lock the row (`FOR UPDATE`), apply `planStatusChange`, update the row, and insert the `status_change` event, plus a `note` event if a note was given.
- `addEvent`: validates per §4.2. `follow_up_done` clears `follow_up_at`; `follow_up_snoozed` sets it. Both happen in the same transaction as the event insert.
- `updateApplication`: edits free-text fields, `applied_at`, `follow_up_at` and document links (links re-validated for same-job). The snapshot is never edited.
- `deleteApplication`, `listApplications({ status?, dueOnly? })` (including a `dueCount` where `follow_up_at <= today`), `getApplication` (with ordered events), `getApplicationForJob`.

### 4.5 Retention (`retention.ts` pure + `retentionSweep.ts` DB/storage)
- `planRetention({ applications, now, retentionDays })` returns the applications to purge: `retentionDays > 0`, `job_id IS NOT NULL`, `terminal_at <= now − retentionDays`, and not already purged since that `terminal_at` (see "Reopen after purge" below). External applications are excluded because they have no generated data.
- `planOrphanSweep({ objects, referencedKeys, now, minAgeMs = 24h })` returns object keys that are not referenced and whose `lastModified` is older than `minAgeMs`. The age guard protects an export that has uploaded its object but not yet committed its row.
- `runRetentionSweep({ db, storage, userId, now, retentionDays })`:
  1. Select candidates and apply `planRetention`.
  2. For each planned application, in one transaction:
     1. Re-read the application row with `FOR UPDATE SKIP LOCKED`; skip it if it is locked, gone, or no longer due. This replaces a per-user advisory lock: session-level advisory locks are unreliable on a pooled connection, and row locks make two concurrent sweeps skip each other's work.
     2. Collect the job's `generated_documents` object keys.
     3. Delete the job's `generated_documents`, `resume_optimizations` (ATS evaluations cascade), `application_pitches`, `cover_letters` and `interview_preparations` rows.
     4. Set `retention_purged_at`, and insert a `documents_purged` event with counts only.
  3. **After** the transaction commits, delete the collected MinIO objects one by one; S3 delete is idempotent.

     Rows go first, so a crash can only leave objects without rows, never rows pointing at missing objects. Those objects are exactly what the orphan sweep collects.
  4. Orphan sweep: list `generated-documents` under `{userId}/`, diff against referenced keys, and delete per `planOrphanSweep`.
  5. Return counts. Log ids and counts only.
- Company research (company-level, not per-application) is kept.
- **Reopen after purge.** A purged application that is reopened stays purged; deleted data is not restored. While an application exists its job is ineligible (§5), so the generation routes refuse new documents for it; a job with no generated rows purges to zero counts. Reaching a terminal status again sets a new `terminal_at`, which is later than `retention_purged_at`, so it becomes eligible again. The planner's full condition is therefore `terminal_at <= now − retentionDays AND (retention_purged_at IS NULL OR retention_purged_at < terminal_at)`. A terminal→terminal change keeps `terminal_at` (§4.1), so it never triggers a second purge.
- `RETENTION_DAYS` (config, integer ≥ 0, default 30). `0` disables the sweep.

## 5. Matching change

`packages/matching` eligibility gains a rule. The retrieval step loads the set of `job_id`s with an application (one query per run). A job in that set gets `eligible=false`, with reason `You applied to this job at {company}.` This is checked first, before "dismissed". It is deterministic and has no LLM involvement. Existing `job_matches` rows update on the next run. The match detail page shows the application status immediately via `GET /api/applications/for-job/[jobId]`.

Because an applied job becomes ineligible, `GET /api/matches/[jobId]` also returns `applicationId` (or null). `MatchDetailClient` then keeps showing the resume/pitch/cover-letter/interview-prep/documents panels when the match is eligible **or** an application exists, so the documents you sent stay viewable after the next matching run. Generating new versions for an applied job is refused by the existing "not an eligible match" check. This is accepted: the application is the record of what was sent.

## 6. API

Routes validate with Zod and call `packages/applications`. All run as `DEFAULT_USER_ID` under RLS.

| Method + path | Purpose | Errors |
|---|---|---|
| `POST /api/applications` | Create. Body: `{ jobId }` or `{ external: { companyName, jobTitle, jobUrl? } }`, plus optional `resumeOptimizationId`, `applicationPitchId`, `coverLetterId`, `appliedAt`, `followUpAt`, `notes`. | 400, 404 job, 409 already applied, 422 document not for this job |
| `GET /api/applications?status=&due=1` | List (most recent `applied_at` first) + `dueCount`. | 400 |
| `GET /api/applications/[id]` | Detail + ordered events + linked documents that still exist (with their `generated_documents` downloads). | 404 |
| `PATCH /api/applications/[id]` | Edit free-text, dates, document links. | 400, 404, 422 |
| `POST /api/applications/[id]/status` | `{ toStatus, occurredAt?, note? }`. | 400, 404, 409 same status |
| `POST /api/applications/[id]/events` | User event types from §4.2. | 400, 404 |
| `DELETE /api/applications/[id]` | Remove (mistakes); events cascade; the job returns to the match feed on the next run. | 404 |
| `GET /api/applications/for-job/[jobId]` | `{ application: {id, status, appliedAt} \| null, documentOptions: { resumes, pitches, coverLetters } }`. Each option is `{id, version, origin}`, newest first. The Mark-as-applied panel needs one call. | 404 non-UUID |

Other users' rows are invisible under RLS, so they return 404. Unexpected errors return 500 with a generic message; logs carry the error class, never note, recruiter or document content.

## 7. UI

- **`/matches/[jobId]`**: an "Application" panel.
  - Not applied: a "Mark as applied" form with dropdowns for resume/pitch/cover-letter versions (latest preselected, or "none"), applied date (today) and optional follow-up date.
  - Applied: "Applied on {date} · {status}" and a link to `/applications/[id]`.
- **`/applications`**:
  - A "Follow-ups due" section (overdue or today) with Done and Snooze (date picker) buttons.
  - Status filter chips.
  - A table: company, title, status, applied, follow-up, and an "external" tag.
  - An "Add external application" form.
- **`/applications/[id]`**:
  - Header with company and title, plus job/posting links when present.
  - A status select. Choosing a terminal status shows the confirmation "Documents generated for this job will be deleted after {RETENTION_DAYS} days".
  - Sent documents, as "Resume v3 / Pitch v2 / Cover letter v1" from the snapshot, with a link to `/matches/[jobId]` where the panels and downloads live, or "Documents deleted after retention period" once purged.
  - An editable fields form.
  - The event timeline and a log-event form (note / recruiter contact / interview).
  - A one-line "Match {overall} · ATS {overall} at time of applying" from the snapshot. The full snapshot is not shown.
- **Home nav**: "6. Applications — track what you've applied to".

## 8. Maintenance worker

`services/maintenance-worker`, same shape as `services/job-ingestion`:
- A BullMQ queue `maintenance` with a job scheduler `retention-daily` (every 24h, upserted on boot).
- A worker that calls `runRetentionSweep` for `DEFAULT_USER_ID`.
- Structured logs with counts only.

`pnpm retention:run` runs the same function once from a script. No Dockerfile is added; this matches the existing workers (known gap, architecture §10).

## 9. Testing

TDD per CLAUDE.md §10.
- **Unit:** `planStatusChange` (all terminal/non-terminal combinations, terminal→terminal keeps the clock, same status errors); the event Zod schemas; `buildFeatureSnapshot` (ingested with full data, ingested with no match/ATS/documents, external); `planRetention` (boundary at exactly N days, `0` disables, external excluded, already purged, reopened then re-terminated); `planOrphanSweep` (24h guard, referenced keys kept).
- **Integration** (real Postgres + MinIO):
  - RLS isolation on both tables.
  - Create writes the application and its initial event atomically; a duplicate job gives 409; a cross-job document gives 422.
  - A status change writes its event, and `terminal_at` is set and cleared.
  - Follow-up done/snooze.
  - Deleting a job nulls `job_id` and the application survives.
  - The purge removes exactly one job's objects and rows and leaves another job's untouched.
  - A row-locked application is skipped.
  - An object whose removal fails after commit is collected by a later orphan sweep.
  - The orphan sweep respects the 24h guard.
  - The "already applied" eligibility rule, and the job returns after the application is deleted.
- **Routes:** every endpoint's success and error codes.
- **Components:** Mark-as-applied panel, list with due section, detail status change with terminal confirmation.
- **E2E** (real Chrome, built app, fake Anthropic per the existing recipe): mark a match as applied → change status to interviewing → log an interview → set rejected → backdate `terminal_at` in the DB → `pnpm retention:run` → the detail page shows documents deleted and the MinIO objects are gone.

## 10. Risks

- **Retention deletes irreversibly.** It is mitigated by the terminal-status confirmation, the `RETENTION_DAYS=0` kill switch, rows-before-objects ordering, and per-job scoping tested against a second job's data.
- **The snapshot only reflects data at apply time.** A match computed against an older goal is recorded as-is (with its `careerGoalId`) rather than recomputed.
- **External applications give Phase 10 sparse features.** They are flagged `external: true`, so Phase 10 can exclude or down-weight them.
- **Free-text fields may hold PII** (recruiter contact). They are covered by the existing redaction and never logged.

## 11. Post-implementation notes

Deviations and gaps found while building this design, in implementation order (see DECISIONS.md D112–D121
for the full rationale of each):

- **§4.1 `terminal_at`.** Confirmed exactly as designed: it is set to *now*, never the user-supplied,
  possibly-backdated `occurredAt`, and is kept (not reset) on a terminal→terminal status change (D115).
- **§5 matching / applied-job panels.** Implemented as designed, plus one detail the design left implicit:
  because an applied job becomes ineligible on its next matching run, `GET /api/matches/[jobId]` returns
  `applicationId`, and the match page keeps showing the resume/pitch/cover-letter/interview-prep/documents
  panels when `match.eligible || applicationId !== null` — not only when eligible. Generating a *new*
  document version for that (now-ineligible) job is refused by the pre-existing "not an eligible match"
  check; this is accepted, since the application record is what was actually sent (D118).
- **§4.5 retention.** Implemented as designed (rows in a per-application transaction with
  `FOR UPDATE SKIP LOCKED`, MinIO objects removed only after commit, an orphan sweep with a 24h age guard)
  — D119. One gap surfaced during implementation, not anticipated by the design: `failedObjectDeletes` can
  double-count a single object that fails to delete during its own purge step and then fails again in that
  same run's orphan sweep, since the key is already unreferenced and past the 24h guard by the time the
  orphan sweep runs. (Fixed after the final review: failed keys are tracked in a per-run `Set`, so each
  counts once -- D123.)
- **`GET /api/applications/[id]` documents (§6 table).** The route returns the versions sent through the
  `snapshotSummary` built from `feature_snapshot` (resume, pitch and cover-letter version numbers, plus the
  match and ATS scores), not "linked documents that still exist (with
  downloads)". The detail page lists those versions and links to `/matches/[jobId]`, where the documents and
  their downloads live until retention deletes them.
- **Date bounds (added after the final review, D123).** `appliedAt` (create and update) may not be after
  today (UTC, 5-minute clock-skew allowance); a snoozed follow-up date must be strictly after today.
- **Ingested `job_url` (not in the original design text).** `createApplication` copies the job's most
  recently seen posting URL only when it is http(s); `packages/ingestion` does not constrain a posting's
  `url` field to http(s) at all, so a non-conforming URL is silently dropped rather than stored, and the
  application detail page independently re-checks the scheme before rendering it as a link, as defense in
  depth (D113).
- **Calendar dates are UTC, not local.** Both the server (`todayUtc`) and the client (`ApplicationPanel`'s
  default applied-date) compute "today" from `toISOString().slice(0, 10)`, i.e. the UTC calendar day, not
  the browser's local one. For a user well away from UTC, this can be off by a day for a few hours around
  midnight local time. Not fixed in this phase.
- **`packages/applications` test helper.** The `postgres.js` admin client used by the integration test
  helpers (`packages/applications/src/testing/db.ts`) rejects a raw JS `Date` as a tagged-template parameter
  once `drizzle(adminSql)` has wrapped it: Drizzle's postgres-js driver (`drizzle-orm/postgres-js/driver.js`)
  replaces the shared client's date/timestamp parsers and serializers with pass-throughs. (`migrate()` is not
  the cause.) Tests that backdate a timestamp pass an ISO string with an explicit `::timestamptz` cast instead.
