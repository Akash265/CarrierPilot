# Phase 8 — Browser Automation (Guarded Autofill): Design

Date: 2026-10-01
Status: Implemented on branch `worktree-phase-8-browser-automation` (2026-10-01); see §12 for post-implementation notes.
Spec sources: project spec §4 (stop-before-submit invariant), §13 (Application Automation — Human-in-the-Loop), §17 (Playwright worker), §19 (`automation_sessions`), §20 (`packages/browser`, `services/browser-worker`), §21 (Phase 8); DECISIONS D4 (revised here), D112 (Phase 9 recorded applications without automation).

## 1. Scope

Phase 8 opens a supported job application form in a headed Chrome window on the user's machine, fills the fields it can identify with high confidence, attaches the generated resume (and cover letter if one exists), records a per-field audit, and hands the window to the user. **The user reviews and clicks Submit.** The worker never submits.

In scope:
- `automation_sessions` table (+ RLS).
- New pure package `packages/browser`: adapters (`greenhouse-v1`, `lever-v1`), form-snapshot types, field classification, value mapping, fill-plan builder, confirmation detection.
- New host-run service `services/browser-worker` (BullMQ consumer, `playwright-core`, system Chrome).
- API routes under `/api/automation-sessions`; `POST /api/applications` gains an optional `automationSessionId`.
- `AutofillPanel` on `/matches/[jobId]`.

Out of scope (deferred):
- Workday, Ashby, and company-hosted / iframe-embedded forms.
- LLM-drafted answers to free-text questions.
- New profile fields (GitHub, website, structured work authorization).
- Reattaching to a browser window orphaned by a worker restart.
- A Chrome extension.
- A Docker/compose service for the browser worker (it must run on the host — a headed window needs the user's desktop).

## 2. Decisions taken in brainstorming

1. **Guarded autofill, revising D4.** D4 ("Auto-Prep, not autofill") is superseded: Playwright does fill live forms, but only fields with exactly one confident canonical match, each verified by reading the value back. D4's protections survive as: versioned adapters, a selector health check that falls back to manual mode with nothing filled, and stop-before-submit enforced in code.
2. **Fields: standard + rule-based.** Standard fields map from the profile. Only two custom questions are answered, and only deterministically from confirmed data: visa sponsorship (from the goal's `visaSponsorshipRequired`) and salary expectation (from the parsed salary target). Free text, EEO/demographics, work-authorization and anything unrecognized are flagged, never filled.
3. **Tracker link: detect, then the user confirms.** The worker passively detects the ATS confirmation page and marks the session `submission_detected`; the app then offers "Record as applied?". Nothing is written to `applications` without the user's click.
4. **Architecture A:** pure logic in `packages/browser` (no Playwright imports), a thin host-run BullMQ worker in `services/browser-worker`, the web app enqueues and polls. Rejected: launching Playwright from a Next.js route (long-lived browser in the web process, killed by dev reloads); a Chrome extension (packaging and messaging overhead; not the spec's Playwright worker).

## 3. Data model

### `automation_sessions`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid not null, default `current_setting('app.current_user_id')` | RLS, same policy pattern as every other table |
| `job_id` | uuid not null → `jobs` ON DELETE CASCADE | sessions exist only for ingested jobs |
| `application_id` | uuid null → `applications` ON DELETE SET NULL | set by "Record as applied" |
| `portal` | enum `automation_portal`: `greenhouse`, `lever` | |
| `adapter_version` | text not null | e.g. `greenhouse-v1` |
| `form_url` | text not null | canonical hosted form URL actually opened |
| `status` | enum `automation_status` (see §3.1) | |
| `resume_document_id` | uuid null → `generated_documents` SET NULL | file attached |
| `cover_letter_document_id` | uuid null → `generated_documents` SET NULL | file attached, if any |
| `field_audit` | jsonb not null default `[]` | array of `FieldAuditEntry` (§4.5); CHECK `jsonb_typeof = 'array'` |
| `stopped_before_submit` | boolean not null default true | spec §19 field; the worker has no submit path, so it stays true |
| `cancel_requested_at` | timestamptz null | set by the cancel route, polled by the worker |
| `error_code` | text null | set only with `failed` / `needs_manual` |
| `submission_detected_at` | timestamptz null | |
| `started_at` | timestamptz null | when the worker picked the job up |
| `ended_at` | timestamptz null | set on every terminal status |
| `created_at`, `updated_at` | timestamptz | |

Indexes and constraints:
- Partial unique index on `(user_id)` WHERE `status IN ('queued','launching','filling','awaiting_user')`: at most one active session per user (custom migration, like the existing partial indexes).
- Index on `(user_id, job_id, created_at desc)` for the per-job list.
- CHECK: `ended_at IS NOT NULL` exactly when status is terminal (`status::text IN (...)`, same one-transaction enum caveat as `applications`).
- An application can be linked by at most one session: partial unique index on `application_id` WHERE NOT NULL.

### 3.1 Lifecycle

```
queued → launching → filling → awaiting_user ─┬─(confirmation page seen)──▶ submission_detected
                         │                    └─(window closed / timeout / cancel)──▶ abandoned
                         └─(no supported form / health check failed / off-host redirect)──▶ needs_manual
any non-terminal ──(crash / worker restart / launch error)──▶ failed
```

Terminal: `submission_detected`, `abandoned`, `needs_manual`, `failed`.

- `needs_manual`: nothing is filled; the window is left open for the user and the worker stops tracking it (closed at the session timeout like any other).
- On worker startup, every session in `launching`, `filling` or `awaiting_user` is swept to `failed` with `error_code = 'worker_restart'` (see §11.5: a `queued` session is left alone, since no worker had claimed it). Orphaned windows are not reattached.
- A queued session that never gets picked up is left for the worker, and the POST route rejects a new session while one is active (409). The UI shows a "cancel" control for a stuck `queued` session; the cancel route moves `queued` straight to `abandoned` (it has no worker polling `cancel_requested_at` to act on it otherwise).

### 3.2 Unchanged
`applications`, `generated_documents`, profile and goal tables are unchanged. The link lives on `automation_sessions.application_id` (D112 anticipated this direction).

## 4. Package `packages/browser` (pure, no Playwright)

### 4.1 Adapter contract
```ts
interface PortalAdapter {
  portal: "greenhouse" | "lever";
  version: string;                       // "greenhouse-v1"
  allowedHosts: string[];                // navigation allowlist
  buildFormUrl(input: { sourceSlug: string; externalId: string }): string;
  healthCheck: HealthCheckSpec;          // required elements in the snapshot
  standardFields: StandardFieldRule[];   // canonical → ordered matchers (label regex, name, id, autocomplete)
  confirmation: ConfirmationSpec;        // URL patterns + page-text patterns
}
```
- Greenhouse: `https://job-boards.greenhouse.io/{slug}/jobs/{externalId}`; hosts `job-boards.greenhouse.io`, `boards.greenhouse.io`.
- Lever: `https://jobs.lever.co/{slug}/{externalId}/apply`; host `jobs.lever.co`.
- `slug` and `externalId` are URL-encoded and validated against `^[A-Za-z0-9._-]+$`; anything else → unsupported.
- `resolveAutofillTarget(job's open postings + their sources)` picks the first open posting from a Greenhouse or Lever source and returns `{adapter, formUrl}` or `{unsupported: reason}`. The scraped posting `url` is not used (it is often a company page with an iframe).

### 4.2 Form snapshot
The worker extracts a serializable `FormSnapshot` from the page: for every `input`/`select`/`textarea` inside the form root: a stable `key` (worker-assigned index + selector), tag, type, name, id, autocomplete, associated label text (`<label for>`, wrapping label, `aria-label`, `aria-labelledby`), required flag, and for selects/radio groups the option labels. Also: page URL, a capped sample of visible text (for confirmation detection). Snapshot text is untrusted and only ever matched against fixed regexes — it is never sent to an LLM.

### 4.3 Values
`buildAutofillValues(profile, activeGoal, documents)` produces the value set. Every value carries its `valueSource` label (e.g. `profile.email`, `goal.visaSponsorshipRequired`).

| canonical | source | rule |
|---|---|---|
| `first_name`, `last_name` | `profile.fullName` | split on the last whitespace; single-token name → both flagged |
| `full_name` | `profile.fullName` | |
| `email` | `profile.email` | |
| `phone` | `profile.phoneNumber` | null → skipped |
| `location` | `profile.addressLine1` | plain text input only; autocomplete/combobox widget → flagged |
| `linkedin` | `profile.linkedinUrl` | null → skipped |
| `resume` | latest `generated_documents` (kind resume, format pdf) for this job | missing → flagged "export a resume for this job first" |
| `cover_letter` | latest cover-letter pdf for this job | missing → skipped |
| `sponsorship` | `goal.visaSponsorshipRequired` | strict label regex **and** a Yes/No radio group or select; null → flagged |
| `salary_expectation` | `goal.salaryTargetNormalized` + `salaryTargetCurrency` when `salaryTargetIsParsed` | plain text input only; never the floor; otherwise flagged |

Always flagged (never filled): GitHub, website/portfolio, work authorization / right-to-work, EEO and demographic questions (audit reason `intentionally_not_filled`), free-text questions, and any unrecognized field. Unrecognized **optional** fields are recorded as `skipped`, required ones as `flagged`.

### 4.4 `buildFillPlan(snapshot, adapter, values)`
Returns `{ health: "ok" | {failed: missing[]}, actions: FillAction[], audit: FieldAuditEntry[] }`.
- Health check fails → no actions; every field audited as `skipped` with reason `health_check_failed`.
- A field is filled only if exactly one canonical rule matches it and no other field matches the same canonical. Ambiguity → `flagged` (`ambiguous_match`).
- `FillAction` kinds: `fill` (text), `selectOption`, `check` (radio/checkbox by option label), `setInputFiles` (`resume` | `cover_letter`). There is no click/press/submit action kind.
- Elements of tag `button`, `a`, or `input[type=submit|button|image|reset]` are never targets.

### 4.5 Audit entry
```ts
type FieldAuditEntry = {
  key: string; label: string | null; required: boolean;
  canonical: string | null;
  action: "filled" | "flagged" | "skipped";
  reason: string | null;        // e.g. "ambiguous_match", "no_value", "intentionally_not_filled", "verify_mismatch"
  valueSource: string | null;   // e.g. "profile.email" — never the value itself
  verified: boolean | null;     // read-back result for filled fields
};
```
No field values are stored anywhere in the audit (CLAUDE.md §9). Label text is stored, truncated to 200 chars.

### 4.6 `detectSubmission(adapter, {url, visibleText})`
Pure match against `adapter.confirmation`. Greenhouse: URL containing `/confirmation` or thanks text ("Thank you for applying" family). Lever: URL no longer ending in `/apply` on `jobs.lever.co` plus thanks text ("Application submitted" family). Patterns are fixtures-tested.

## 5. Service `services/browser-worker`

- BullMQ queue `browser-automation`, concurrency 1. Queue name and job payload `{sessionId, userId}` are exported from `packages/browser` (constants only — no BullMQ import there); enqueue lives in `apps/web/src/lib/browser-automation/enqueue.ts`, mirroring `lib/matching/enqueue.ts`.
- Launch: `playwright-core` `chromium.launch({ channel: "chrome", headless: BROWSER_HEADLESS })`, `BROWSER_EXECUTABLE_PATH` overrides the executable. `BROWSER_HEADLESS` defaults to false and exists for tests only.
- A fresh `launchPersistentContext` in a new temp directory per session (no user cookies/logins); deleted at session end.
- Steps (status written to the DB after each):
  1. `launching`: load session/job/profile/goal/documents under `withUserContext`; download attachments from MinIO to the session temp dir as `resume.pdf` / `cover_letter.pdf`; launch.
  2. `filling`: navigate to `form_url`; verify the final host is in `allowedHosts` (else `needs_manual`, `off_host_redirect`); snapshot; `buildFillPlan`; execute actions through the guarded action layer; read back each filled value and update `verified`; persist audit.
  3. `awaiting_user`: listen for navigation/DOM changes (debounced) and run `detectSubmission`; watch for page/context close; poll `cancel_requested_at` every 2 s; extend the BullMQ lock.
  4. End: `submission_detected` / `abandoned` / `needs_manual` / `failed`; on `abandoned` by cancel or timeout the worker closes the browser. On `submission_detected` the browser is left open for the user to read the confirmation, and closed at the timeout.
- Timeout `BROWSER_SESSION_TIMEOUT_MIN` (default 30) from entering `awaiting_user`.
- **Guarded action layer** (`actions.ts`): the only module that touches Playwright locators. Exposes `fill`, `selectOption`, `check`, `setInputFiles`; each first asserts the element's tag/type is not a button, link, or submit/image/reset input. `locator.fill` does not send Enter.
- **Structural test**: a unit test scans `services/browser-worker/src/**` (non-test files) and fails on `.click(`, `.press(`, `.dblclick(`, `.tap(`, `.submit(`, `keyboard`, `requestSubmit`, `dispatchEvent`.
- Logging: session id, status, error code, counts. Never field values, labels or URLs with query strings.
- Startup sweep (§3.1) runs before the worker starts consuming.
- Not containerized; README documents `pnpm --filter browser-worker start`.

## 6. API (`apps/web`)

- `POST /api/automation-sessions` `{ jobId }`
  - 400 bad body; 404 job not found; 409 `profile_missing`; 422 `unsupported` (with reason from `resolveAutofillTarget`); 409 `session_active` (also caught from the partial unique index); 503 if enqueue fails (row moved to `failed`, `enqueue_failed`).
  - Returns 201 with the session view.
- `GET /api/automation-sessions?jobId=` — sessions for the job, newest first, plus `support: {supported: boolean, reason?, portal?}` and `resumeAvailable: boolean` so the panel can render its button state in one request.
- `GET /api/automation-sessions/[id]` — session view (status, portal, audit, documents, timestamps, `applicationId`).
- `POST /api/automation-sessions/[id]/cancel` — `queued` → `abandoned` directly; other active states → sets `cancel_requested_at` (worker ends it); terminal → 409.
- `POST /api/applications` — new optional `automationSessionId`. When present: the session must belong to the user, be in `submission_detected` or `abandoned`, have the same `job_id`, and have no `application_id` (else 409). The application is created with the session's attached resume/cover-letter provenance as defaults, and `application_id` is set in the same transaction.

All routes use `withUserContext`; RLS isolates rows.

## 7. UI — `AutofillPanel` on `/matches/[jobId]`

- Button "Open & autofill application (Greenhouse|Lever)". Disabled with a stated reason when: unsupported job, no resume export for this job (link to the download controls), or an active session exists.
- While active: status line (Queued / Opening browser / Filling / Waiting for you in the browser window), a Cancel button, polling every 2 s.
- Audit list: flagged fields first under "Complete these in the browser window, then click Submit yourself", then filled (✓, with `verified:false` shown as a warning), then intentionally-not-filled.
- `submission_detected`: banner "Looks like you submitted. Record as applied?" → existing ApplicationPanel flow with `automationSessionId`.
- `abandoned`: quieter "Did you submit anyway? Record as applied".
- `needs_manual` / `failed`: explanation plus the form URL as a link to open manually.
- Past sessions for the job listed compactly beneath.

## 8. Error handling

| condition | result |
|---|---|
| Chrome not found / launch error | `failed`, `browser_launch_failed` |
| Navigation timeout / non-2xx | `needs_manual`, `navigation_failed` |
| Off-host redirect | `needs_manual`, `off_host_redirect` |
| Health check fails | `needs_manual`, `health_check_failed` (nothing filled) |
| One action throws | that field audited `flagged` `fill_error`; continue with the rest |
| Read-back mismatch | `verified:false`, `flagged` `verify_mismatch` |
| MinIO download fails | resume/cover letter audited `flagged` `attachment_unavailable`; continue |
| Worker restart | startup sweep → `failed`, `worker_restart` |
| Redis down at enqueue | 503, row `failed` `enqueue_failed` |

## 9. Testing

- **Unit (`packages/browser`)**: form-URL building and slug validation; `resolveAutofillTarget`; name splitting; values table rules (sponsorship null, salary floor never used, unparsed target); `buildFillPlan` against sanitized fixture snapshots captured from real Greenhouse and Lever forms (health ok/failed, ambiguity, required vs optional unrecognized, EEO not filled); `detectSubmission`; audit entries contain no values (assert none of the profile values appear in serialized audit).
- **DB**: RLS isolation test for `automation_sessions` (prior-phase parity: every phase has one), constraint tests (one active session, ended_at CHECK, unique application link).
- **Worker integration**: local HTTP server serving fixture HTML replicas of each portal's form and confirmation page; headless system Chrome (`BROWSER_HEADLESS=true`), adapter `allowedHosts`/form URL overridden to the local server via test injection. Covers: fills land and verify, files attach, health-check failure path, off-host redirect, detection when **the test** clicks the fixture's submit, cancel, timeout, startup sweep. Plus the structural no-click test.
- **Routes**: status codes in §6, including the `automationSessionId` application link and its 409s.
- **UI**: AutofillPanel states.
- **E2E**: headed run against fixture pages through the real app and worker; plus one manual run against one live Greenhouse and one live Lever posting, stopping before Submit, to confirm selectors against production forms (recorded in DECISIONS).
- Test user ids for new test files are checked against the whole repo before use (recurring collision lesson).
- No new AI path, so no new evals.

CI: the worker integration tests run headless against the Google Chrome preinstalled on GitHub's `ubuntu-latest` image (`channel: "chrome"`); no browser download step. Locally they use the system Chrome; if Chrome is absent the integration suite fails with an explicit "Chrome not found" message rather than silently skipping.

## 10. Risks

- **Live forms drift from fixtures.** Mitigated by versioned adapters, the health check, read-back verification and the manual live check; failure mode is `needs_manual`, not a wrong fill.
- **Confirmation detection false positives/negatives.** Only a hint; recording requires the user's click, and `abandoned` sessions can be recorded too.
- **Employer-specific custom questions** are mostly flagged; time saved is mainly on standard fields and attachments. Accepted for v1.
- **Bot detection / CAPTCHA** on the hosted forms: the user is in the window and handles it; the worker never solves CAPTCHAs.
- **Terms of service**: the user submits manually from a normal browser session; no automated submission. LEGAL.md gets a short note.

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

## 12. Post-implementation notes

Deviations from this spec found while implementing Tasks 1–10, and corrections to the spec text itself:

1. **Migration 0027's partial index casts the enum literals, not the column.** `automation_sessions_one_active_per_user`'s predicate is `status IN ('queued'::automation_status, 'launching'::automation_status, 'filling'::automation_status, 'awaiting_user'::automation_status)`, not `status::text IN (...)` as §3's CHECK constraint uses. Postgres rejects `status::text` in an index predicate because the `::text` cast on an enum column is not `IMMUTABLE`, which a predicate requires (the CHECK constraint is allowed to use it because a CHECK is evaluated per-row, not baked into an index). See DECISIONS.md D132.
2. **§4.3's "sponsorship"/"salary_expectation" are always flagged when unfilled, like resume — not just when required.** `buildFillPlan`'s `isAlwaysFlag` applies the same always-flag rule to all three canonicals, regardless of the field's own `required` attribute, so the user never misses a visa/salary question or a missing resume just because the site happened to mark it optional. See DECISIONS.md D129.
3. **`ReleasedWindows.release` is idempotent.** A second `release()` call for the same handle (e.g. a timeout extension) replaces the pending close deadline rather than registering a second `context.on("close", ...)` listener, which would otherwise close the window twice.
4. **Worker cleanup hardening beyond §5/§11.6's description**, all to make sure a crashed or killed worker never leaks a temp profile/attachment directory or silently swallows a real bug: the released-window registry has a separate "active window" slot (`setActive`) so shutdown's `closeAll()` also closes the window of a session still in progress, not only windows already handed to the user; at startup, `removeStaleSessionDirs` deletes every leftover `careerpilot-autofill-*` temp directory under the single-worker assumption; an unexpected error anywhere in `runSession` is recorded as `failed`/`unexpected_error` and then rethrown, so BullMQ marks the job failed and `main.ts` logs the error's class (never its message, which could carry a selector or URL); a session's `rootDir` is removed if anything fails before the browser launches; a cancel request is honored before any window is released to the user; a window is only handed to the released registry when its terminal DB transition actually applied (a concurrent cancel or sweep means there's nothing to release, so the handle is just closed); and the shutdown handler is guarded against running twice (e.g. a double Ctrl-C). See DECISIONS.md D132.
5. **`AutofillPanel`'s effects are structured around the repo's `react-hooks` lint rules** (state is set from inside a plain function's own `.then`/`.catch` chain, never directly inside a `useEffect` body), the same idiom `ResumeOptimizationPanel` already uses elsewhere in this codebase. Behavior is unchanged from a naive implementation; this is purely to satisfy `eslint`.
6. **§3.1's "every non-terminal session is swept" conflicted with §11.5's "the startup sweep only touches launching/filling/awaiting_user."** §3.1 has been corrected in place to match §11.5 — a `queued` session is never swept; it waits for the worker, and a stuck one is cancelled (moved straight to `abandoned`) through the cancel route instead. See DECISIONS.md D133.
7. **The dev database needs migrations `0026`/`0027` applied before the worker will do anything useful.** `pnpm --filter @ai-career/db db:migrate` adds the `automation_sessions` table; this is called out as a setup step in the README's new "Browser autofill" section.

No other deviations from this spec's data model, API contract, or UI behavior were found.
