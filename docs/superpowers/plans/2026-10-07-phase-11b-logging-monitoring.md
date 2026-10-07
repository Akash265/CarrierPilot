# Phase 11b — Structured Logging, PII Scrubbing & Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every process logs structured JSON lines through one logger that never prints an error's message and redacts the user's identifying values (D9); errors escaping web routes become a logged 500 with a request id; workers beat to Redis and `/status` shows workers and queues.

**Architecture:** New dependency-free `@ai-career/logging` (logger, sanitizer, D9 redactor, refresher, `initProcessLogging`) and new `@ai-career/monitoring` (heartbeats, worker state, queue status). `packages/db` gains `loadRedactionValues`. Workers and the maintenance script call `initProcessLogging` and `startHeartbeat`; all 40 web routes are wrapped in `withRouteErrors`; `instrumentation.ts` covers render errors; `GET /api/status` + `/status` read the heartbeats and BullMQ counts.

**Tech Stack:** TypeScript (ESM, raw-TS workspace packages), Node streams, ioredis 5 / BullMQ 5, Drizzle/PostgreSQL with RLS, Vitest, Next.js 16 App Router (instrumentation), React 19, Testing Library, Playwright-core (E2E only).

**Spec:** `docs/superpowers/specs/2026-10-07-phase-11b-logging-monitoring-design.md` — read it before starting any task. **§10 (planning refinements) overrides earlier sections where they disagree.**

## How the code in this plan is delivered

The code was written and verified before this plan was committed (draft worktree, then a clean replay from `main`): every task's tests fail before its implementation and pass after it; web build (no warnings), typecheck, lint (0 warnings) and the forced full suite pass at every task's state; `git diff --check` is clean at every commit; a real-Chrome E2E (12 checks) passes at the end. To keep the implementation byte-identical to what was verified, each task's code ships as patch files next to this plan, applied in order with `git apply --index` from the repository root:

`docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-N-tests.patch` and `task-N-impl.patch` (Tasks 11 and 12 have an impl patch only). The E2E script is in the sibling `e2e/` directory.

**After applying any patch that touches a `package.json` or `pnpm-lock.yaml`, run `pnpm install --frozen-lockfile` before running tests** (Tasks 2, 4, 7, 8, 9). For the two new packages (Tasks 2 and 7) the tests patch carries the package scaffold and its lockfile entry, so the red run works before the source exists.

Each task below states what its patches contain (files, behaviour, key signatures) so a reader can review them without opening the patch. **Read both patch files before applying them** — they are the code under review. Do not hand-edit patched files beyond what a review finding requires.

## Global Constraints

- Env (exact): `LOG_LEVEL` ∈ `debug|info|warn|error`, default `info`; `STATUS_STALE_AFTER_MS` integer ≥ 1000, default `90000`; blank = default.
- Log line: one JSON object per line `{ ts, level, service, event, ...fields }`; the logger's four keys win over fields; `warn`/`error` → stderr, `debug`/`info` → stdout; the logger never throws.
- **An error's message is never logged.** An Error becomes `{ name, code?, causeName?, frames }`: `code` only if it matches `^[A-Za-z0-9_:.-]{1,40}$`; ≤ 8 frames, repo-relative `file:line:col`, `node:`/`node_modules` frames dropped. Strings truncated at 500 chars (`…[truncated]`), depth 3 (`"[depth]"`), arrays ≤ 50 (`"[+N more]"`), cycles `"[circular]"`.
- D9: exact case-insensitive replacement of `full_name`, `email`, `phone_number`, `address_line1`, `linkedin_url` (values < 3 chars ignored, longest first) with `[REDACTED]`, then `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` → `[REDACTED_EMAIL]`. Refreshed every 60 s in workers; on the error path (≤ once a minute) in web.
- No `console.` call in production source (guard test).
- Service names: `job-ingestion`, `matching-worker`, `maintenance-worker`, `browser-worker`, `web`, `ai`, `monitoring`. Event names of existing logs are unchanged.
- 500 body (exact): `{ error: "Something went wrong (request <8 hex>). Details are in the server log.", requestId }` + `x-request-id`; log event `request_failed` with `{ requestId, route, method, path (pathname only), error }`; render errors → `render_failed`.
- Heartbeat key `careerpilot:worker:<worker>` = `{ startedAt, beatAt, pid, stoppedAt }`, every 30 s, no TTL. Workers: `job-ingestion`, `matching`, `maintenance` (optional), `browser` (optional). States: `running` (beat age ≤ threshold), `stopped`, `stale`, `never_seen`. Queues: `job-ingestion`, `matching`, `maintenance`, `browser-automation`; failure reason shown only if `^[a-z_]+(:[a-z0-9_]+)?$` (≤ 80 chars).
- `/status` copy (exact): `System status`; `Whether the background workers are running, and what is waiting in their queues.`; `Refresh`; `Checked HH:MM:SS UTC`; state labels `Running`/`Stopped`/`Stale`/`Never seen`; worker labels `Job ingestion`/`Matching`/`Maintenance`/`Browser autofill`; tag `optional`; last failure `YYYY-MM-DD HH:MM · <code>` or `· see the worker log` or `—`; `Failed counts include only the failed jobs each queue keeps, not a lifetime total.`; `Redis is unavailable, so worker and queue status cannot be read.`; `The database is unavailable.`; `Could not load the system status.`; home link `9. System status — workers and queues` (no badge).
- Test user ids (verified unused repo-wide on 2026-10-07): `00000000-0000-0000-0000-000000000c01`/`…0c02` (DB test), `…0c03` (status route test).
- New DECISIONS.md entries: **D166–D172**.
- Commit messages end with exactly (copy literally — never substitute a model name):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
  ```
- Web tests: `pnpm --filter web test -- <paths>`. Run `pnpm --filter web build` before `pnpm --filter web typecheck` in a fresh worktree and after adding routes. Postgres/Redis/MinIO run locally in Docker; DB tests use `career_intel_test`. Web tests load the repo `.env` — never let a test reach the database it names (route tests mock `loadEnv` with the test database).
- Run every `git apply` from the repository root.

## Review Focus

Inputs the spec implies but a reader might not expect to be handled; each is pinned by a test in the task named.

1. **An error whose message contains a profile value or document text** (a Postgres unique violation naming an email, a provider error echoing a resume line) must never appear in any log line — Task 2 (sanitize/logger sentinel tests), Task 5 (`request_failed` sentinel + profile value + query string absent).
2. **A query string carrying search text** (`?q=jane@example.com`) must not be logged — Task 5 (path is pathname only).
3. **A double Ctrl-C / forwarded SIGTERM** must shut a worker down once, record a clean stop, and exit 0 — Task 8 (structural "runs its shutdown only once") and Task 12 (E2E SIGTERM → exit 0, "Stopped").
4. **Redis or the database being down** must not break `/status` — it answers 200 within the timeout and says what is unavailable — Task 9 (route tests against a closed Redis port and a closed DB port), Task 10 (UI notes).
5. **A BullMQ failure reason that is a raw error message** must not be shown on `/status` — Task 7 (`failureCode` and the real-queue test with a sentinel message).

---

### Task 1: Config — `LOG_LEVEL` and `STATUS_STALE_AFTER_MS`

**Files:** Modify `packages/config/src/env.ts`, `.env.example`. Test: `packages/config/src/env.test.ts`.

**Interfaces — Produces:** `Env.LOG_LEVEL: "debug" | "info" | "warn" | "error"`, `Env.STATUS_STALE_AFTER_MS: number`.

**What the patches do:** tests for defaults, bounds (`verbose` rejected, `999` and `1500.5` rejected) and blank values; the implementation adds both fields with the existing `blankAsUnset` preprocess and documents them in `.env.example`.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-1-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/config && npx vitest run` → FAIL: `Tests  3 failed | 28 passed (31)`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-1-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/config test && pnpm --filter @ai-career/config typecheck && pnpm --filter @ai-career/config lint` → 31 passed, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(config): LOG_LEVEL and STATUS_STALE_AFTER_MS (Phase 11b)"` (+ trailer).

---

### Task 2: `@ai-career/logging` — logger, sanitizer, redactor

**Files:**
- Create (tests patch, scaffold + tests): `packages/logging/{package.json,tsconfig.json,eslint.config.mjs}`, `pnpm-lock.yaml` (importer entry), `packages/logging/src/{logger,sanitize,redactor}.test.ts`
- Create (impl patch): `packages/logging/src/{logger,sanitize,redactor,index}.ts`

**Interfaces — Produces:** `createLogger({ service, level?, redactor?, write? }): Logger` (`debug|info|warn|error(event, fields?)`), `configureLogging({ level? })`, `defaultRedactor(): Redactor`, `type LogLevel`, `class Redactor { setValues(values: string[]); redact(text: string): string }`, `sanitize(fields, redactor)`, `serializeError(error): { name; code?; causeName?; frames: string[] }`.

**What the patches do:** tests pin the redactor (case-insensitive, longest first, metacharacters, short values, email pattern, set replacement), `serializeError` (repo-relative frames from absolute, `file://`, Docker and `.next` paths; code allowlist; 8-frame cap; cause by name; sentinel message never present), `sanitize` (types, truncation, depth, arrays, cycles, keys untouched) and the logger (line shape, level filtering, reserved keys, scrubbing, stream routing, never throwing, process-wide level/redactor read at write time and overridable per logger).

- [ ] **Step 1: Apply the test patch and install** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-2-tests.patch && pnpm install --frozen-lockfile`
- [ ] **Step 2: Run it to see it fail** — `cd packages/logging && npx vitest run` → FAIL: `Failed to load url ./logger` / `./redactor` / `./sanitize` (no tests run).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-2-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/logging test && pnpm --filter @ai-career/logging typecheck && pnpm --filter @ai-career/logging lint` → 29 passed, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(logging): structured logger with message-free error serialization and D9 redactor (Phase 11b)"` (+ trailer).

---

### Task 3: Keeping D9 values fresh — refresher, `initProcessLogging`, `loadRedactionValues`

**Files:** Create `packages/logging/src/{refresher,processLogging}.ts`, `packages/db/src/redactionValues.ts`; modify `packages/logging/src/index.ts`, `packages/db/src/index.ts`. Test: `packages/logging/src/{refresher,processLogging}.test.ts`, `packages/db/src/redactionValues.rls.test.ts`.

**Interfaces — Consumes:** Task 2. **Produces:** `createRedactionRefresher(redactor, load, { logger, maxAgeMs?, now? }): { refresh(); refreshIfStale(); startInterval(ms): () => void }`, `initProcessLogging({ level, load, logger, intervalMs? }): Promise<() => void>`, `loadRedactionValues(db, userId): Promise<string[]>`.

**What the patches do:** refresher tests (load, staleness window, shared in-flight load, failed load keeps values and logs `redaction_refresh_failed` with the error only, retry, unref'd interval and stop); `initProcessLogging` tests (level set, values loaded before return, interval refresh, stop, a failing first load still starts); DB tests (users `…0c01`/`…0c02`: non-null values returned, `[]` without a profile, RLS isolation).

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-3-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/logging && npx vitest run src/refresher.test.ts src/processLogging.test.ts` → FAIL: `Failed to load url ./refresher` / `./processLogging`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-3-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/logging test && pnpm --filter @ai-career/db test -- src/redactionValues.rls.test.ts && pnpm --filter @ai-career/logging typecheck && pnpm --filter @ai-career/db typecheck && pnpm --filter @ai-career/logging lint && pnpm --filter @ai-career/db lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(logging): D9 redaction values kept fresh per process; loadRedactionValues (Phase 11b)"` (+ trailer).

---

### Task 4: Every process logs through `@ai-career/logging`

**Files:**
- Modify: `services/{job-ingestion,matching-worker,maintenance-worker,browser-worker}/src/main.ts`, `services/maintenance-worker/src/runOnce.ts`, `packages/ai/src/usage/track.ts`, `apps/web/src/lib/insights/responseModel.ts`, six `package.json` files (`@ai-career/logging` dependency), `pnpm-lock.yaml`
- Create: `apps/web/src/lib/log.ts`
- Test: `packages/logging/src/noConsole.test.ts`, `packages/ai/src/usage/anthropicFor.test.ts`, `apps/web/src/lib/insights/responseModel.test.ts`, `apps/web/src/app/api/matches/route.test.ts`

**Interfaces — Consumes:** Tasks 2–3. **Produces:** `apps/web/src/lib/log.ts` → `log` (service `web`).

**What the patches do:** the guard fails on any `console.` call in production source. Each worker: `const log = createLogger({ service })`, `await initProcessLogging({ level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log })` right after the DB client, the stop function called in shutdown; failures at `error` with the sanitized error (plus `errorClass` for the ingestion/matching workers' own error classes), everything else at `info`. `ai_usage_record_failed` and `response_model_failed` move to the logger (the tests now read the stderr line and assert `error: { name, code? }` and no sentinel).

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-4-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/logging && npx vitest run src/noConsole.test.ts` → FAIL: `Tests  1 failed | 1 passed (2)`, listing exactly the 7 files above.
- [ ] **Step 3: Apply the implementation patch and install** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-4-impl.patch && pnpm install --frozen-lockfile`
- [ ] **Step 4: Run, build, typecheck, lint** — `pnpm --filter @ai-career/logging test && pnpm --filter @ai-career/ai test && pnpm --filter web test -- src/lib/insights src/app/api/matches/route.test.ts && pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass, 0 warnings. Optional image check: `docker build -f services/maintenance-worker/Dockerfile -t careerpilot-maintenance-worker:check . && docker run --rm careerpilot-maintenance-worker:check` prints one `worker_crashed` JSON line (no env), proving `@ai-career/logging` ships in the image.
- [ ] **Step 5: Commit** — `git commit -m "refactor: every process logs through @ai-career/logging; no console calls in production code (Phase 11b)"` (+ trailer).

---

### Task 5: `withRouteErrors` and `onRequestError`

**Files:** Create `apps/web/src/lib/http/withRouteErrors.ts`, `apps/web/src/lib/webLogging.ts`, `apps/web/src/lib/renderErrors.ts`, `apps/web/src/instrumentation.ts`. Test: `apps/web/src/lib/http/withRouteErrors.test.ts`, `apps/web/src/instrumentation.test.ts`.

**Interfaces — Consumes:** Tasks 2–4. **Produces:** `makeWithRouteErrors({ refreshRedactions })` and `withRouteErrors<A>(route, handler): (...args: A) => Promise<Response>`; `refreshWebRedactions(): Promise<void>` (never throws); `onRequestError`.

**What the patches do:** see Global Constraints for the 500 body and log line. Tests: own responses untouched (no refresh), 500 + header + one log line with `code` and no sentinel/profile value/query string, a scrubbed path segment, handlers without a request, a failing refresh still answering 500, distinct request ids, `render_failed` on the Node.js runtime only (the refresh is mocked so the test never reads the `.env` database).

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-5-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `pnpm --filter web test -- src/lib/http/withRouteErrors.test.ts src/instrumentation.test.ts` → FAIL: `Failed to load url ./withRouteErrors` / `./instrumentation`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-5-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — the same tests, then `pnpm --filter web build` (output must not contain `Ecmascript file had an error`), `pnpm typecheck && pnpm lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): withRouteErrors and onRequestError -- message-free error logs, 500 with a request id (Phase 11b)"` (+ trailer).

---

### Task 6: Wrap all 40 API routes

**Files:** Modify all 40 `apps/web/src/app/api/**/route.ts`. Test: `apps/web/src/lib/http/allRoutesWrapped.test.ts`, `apps/web/src/app/api/career-goal/route.test.ts`, `apps/web/src/app/api/job-sources/upload/route.test.ts`.

**Interfaces — Consumes:** Task 5.

**What the patches do:** each `export async function GET|POST|PATCH|DELETE|HEAD(` becomes `async function handleX(` (body unchanged), the import of `withRouteErrors` is added after the import block, and `export const X = withRouteErrors("/api/<path with [params]>", handleX);` is appended. The guard checks every route file for no unwrapped export and a pattern equal to its path. Two tests that expected an escaped error now assert the 500 body and that `has no constraints` / `secret-internal-detail` do not leak.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-6-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `pnpm --filter web test -- src/lib/http/allRoutesWrapped.test.ts` → FAIL: `Tests  40 failed | 1 passed (41)`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-6-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — `pnpm --filter web test` (whole web suite) `&& pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): wrap all 40 API routes in withRouteErrors, with a guard test (Phase 11b)"` (+ trailer).

---

### Task 7: `@ai-career/monitoring` — heartbeats, worker state, queue status

**Files:**
- Create (tests patch, scaffold + tests): `packages/monitoring/{package.json,tsconfig.json,eslint.config.mjs}`, `pnpm-lock.yaml` (importer entry), `packages/monitoring/src/{workerState,heartbeat,queueStatus}.test.ts`
- Create (impl patch): `packages/monitoring/src/{workerState,heartbeat,status,index}.ts`

**Interfaces — Consumes:** Task 2. **Produces:** `WORKERS`, `QUEUES`, `DEFAULT_KEY_PREFIX`, `type WorkerName`, `type WorkerState`, `workerState(beat, now, staleAfterMs)`, `failureCode(reason)`, `startHeartbeat(redis, worker, { intervalMs?, now?, keyPrefix?, logger? }): Promise<{ stop(): Promise<void> }>`, `readWorkerStatus(redis, now, { staleAfterMs, keyPrefix? }): Promise<WorkerStatus[]>`, `readQueueStatus(connection, queueNames): Promise<QueueStatus[]>`.

**What the patches do:** state rules at the inclusive threshold, stopped vs restarted, unparseable time; the failure-code allowlist; against real Redis with an isolated key prefix: all workers `never_seen`, immediate write + interval beat + clean stop + no beats after stop, stale after the threshold, malformed value, a write failure never thrown; against isolated real BullMQ queues: counts, our code shown, a raw message withheld, an empty queue.

- [ ] **Step 1: Apply the test patch and install** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-7-tests.patch && pnpm install --frozen-lockfile`
- [ ] **Step 2: Run it to see it fail** — `cd packages/monitoring && npx vitest run` → FAIL: `Failed to load url ./workerState` / `./heartbeat` / `./status`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-7-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/monitoring test && pnpm --filter @ai-career/monitoring typecheck && pnpm --filter @ai-career/monitoring lint` → 15 passed, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(monitoring): worker heartbeats and queue status (Phase 11b)"` (+ trailer).

---

### Task 8: Workers beat, and shut down exactly once

**Files:** Modify `services/{job-ingestion,matching-worker,maintenance-worker,browser-worker}/src/main.ts`, their `package.json` (`@ai-career/monitoring`), `pnpm-lock.yaml`. Test: `packages/monitoring/src/allWorkersBeat.test.ts`.

**Interfaces — Consumes:** Task 7.

**What the patches do:** each worker calls `const heartbeat = await startHeartbeat(connection, "<worker>");` after its worker is ready and `await heartbeat.stop();` in shutdown before `connection.quit()`. The ingestion, matching and maintenance workers gain the browser worker's `let stopping = false` / `if (stopping) return; stopping = true;` guard (spec §10.4). The structural test pins both for all four.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-8-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/monitoring && npx vitest run src/allWorkersBeat.test.ts` → FAIL: `Tests  7 failed | 1 passed (8)` (only the browser worker already has the guard).
- [ ] **Step 3: Apply the implementation patch and install** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-8-impl.patch && pnpm install --frozen-lockfile`
- [ ] **Step 4: Run, typecheck, lint** — `pnpm --filter @ai-career/monitoring test && pnpm typecheck && pnpm lint` → all pass. Optional smoke: from `services/matching-worker`, `DATABASE_URL=<test db> npx dotenv -e ../../.env -- tsx src/main.ts &`, then `pkill -TERM -f "tsx src/main.ts"` (which signals the worker twice): one `worker_started` line, `careerpilot:worker:matching` shows a `stoppedAt`, no "Connection is closed" crash.
- [ ] **Step 5: Commit** — `git commit -m "feat: workers beat to /status and shut down exactly once (Phase 11b)"` (+ trailer).

---

### Task 9: `GET /api/status`

**Files:** Create `apps/web/src/lib/status/loadStatus.ts`, `apps/web/src/app/api/status/route.ts`; modify `apps/web/package.json` (`@ai-career/monitoring`), `pnpm-lock.yaml`. Test: `apps/web/src/app/api/status/route.test.ts`.

**Interfaces — Consumes:** Tasks 6–7. **Produces:** `loadStatus(env, now?): Promise<StatusReport>` with `StatusReport = { checkedAt; database: "ok"|"unavailable"; redis: "ok"|"unavailable"; workers: WorkerStatus[]; queues: QueueStatus[] }`.

**What the patches do:** database `SELECT 1` and Redis `connect()` → `ping` → worker and queue reads, each with a 5 s timeout; Redis opened `lazyConnect` + fail-fast (spec §10.6). Tests (user `…0c03`, test database, shared local Redis — states are asserted by shape only): all ok with 4 workers and 4 queues in order; Redis on a closed port → 200, `redis: "unavailable"`, empty lists, under 6 s; database on a closed port → 200, `database: "unavailable"`.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-9-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `pnpm --filter web test -- src/app/api/status` → FAIL: `Failed to load url ./route`.
- [ ] **Step 3: Apply the implementation patch and install** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-9-impl.patch && pnpm install --frozen-lockfile`
- [ ] **Step 4: Run, build, typecheck, lint** — `pnpm --filter web test -- src/app/api/status src/lib/http/allRoutesWrapped.test.ts && pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass; the build lists `ƒ /api/status`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): GET /api/status (Phase 11b)"` (+ trailer).

---

### Task 10: `/status` page and home link

**Files:** Create `apps/web/src/lib/status/format.ts`, `apps/web/src/app/status/{page,StatusClient}.tsx`; modify `apps/web/src/app/page.tsx`. Test: `apps/web/src/lib/status/format.test.ts`, `apps/web/src/app/status/StatusClient.test.tsx`, `apps/web/src/app/page.test.tsx`.

**Interfaces — Consumes:** Task 9 (`StatusReport` type).

**What the patches do:** `lastSeen` (floored s/min/h/d, `—`, future → `0 s`), `utcMinute`, `workerLabel`; the client fetches `/api/status` (`cache: "no-store"`) on load, every 30 s and on Refresh with a promise chain (the `react-hooks/set-state-in-effect` pattern) and only the newest response applied; tables and notes per Global Constraints; home lists `/status` after `/usage`.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-10-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `pnpm --filter web test -- src/lib/status src/app/status src/app/page.test.tsx` → FAIL: `./format` and `./StatusClient` do not resolve; the home test lacks `/status`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-10-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — the same tests, then `pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass; the build lists `○ /status`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): /status page and home link (Phase 11b)"` (+ trailer).

---

### Task 11: Documentation — D166–D171, architecture §22, FLOW §17, README

**Files:** Modify `DECISIONS.md`, `docs/architecture.md` (status line, §9 two lines, new §22), `FLOW.md` (new §17), `README.md` (status paragraph).

- [ ] **Step 1: Apply the patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-11-impl.patch`
- [ ] **Step 2: Check it** — `grep -c "^### D16[6-9]\|^### D17[01]" DECISIONS.md` → 6; every `[Dnnn]` link in `docs/architecture.md` resolves to a `### Dnnn.` entry.
- [ ] **Step 3: Commit** — `git commit -m "docs: Phase 11b decisions D166-D171, architecture §22, FLOW §17, README"` (+ trailer).

---

### Task 12: Verification and real-browser E2E (D172)

**Files:** Modify `DECISIONS.md` (D172, in `task-12-impl.patch`). Use (not shipped): `docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/e2e/e2e.mjs`.

- [ ] **Step 1: Apply the patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11b-logging-monitoring/task-12-impl.patch`
- [ ] **Step 2: CI-order checks** — `pnpm install --frozen-lockfile && pnpm --filter @ai-career/db db:migrate && pnpm lint && pnpm --filter web build && pnpm typecheck && pnpm turbo run test --force && git diff main --check` → lint 0 warnings; 19/19 packages pass; no whitespace errors.
- [ ] **Step 3: E2E stack** (test database; no matching worker running):
  1. From `apps/web`: `PORT=3112 STATUS_STALE_AFTER_MS=5000 DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test pnpm start > /tmp/webA.log 2>&1 &`
  2. From `apps/web`: `PORT=3113 DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5999/career_intel_test pnpm start > /tmp/webB.log 2>&1 &` (a closed port: every DB route fails).
  3. In a scratch directory with `npm install playwright-core`: copy `e2e.mjs`, run `REPO=<repo root> BASE_URL=http://localhost:3112 BROKEN_URL=http://localhost:3113 BROKEN_LOG=/tmp/webB.log node e2e.mjs <screenshot-dir>` → 12 checks `"ok":true`, then `{"done":true}`. `/tmp/webB.log` contains only Next's startup lines and JSON log lines (no raw error print).
- [ ] **Step 4: Clean up** — stop both web instances (`pkill -f "next start"`); the script stops the worker it started.
- [ ] **Step 5: Commit** — `git commit -m "docs: Phase 11b verification D172"` (+ trailer).
