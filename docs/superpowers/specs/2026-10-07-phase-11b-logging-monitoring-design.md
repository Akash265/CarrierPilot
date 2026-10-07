# Phase 11b — Structured Logging, PII Scrubbing & Monitoring: Design

Date: 2026-10-07
Status: Approved in brainstorming (sections 1–3) and as a written spec on 2026-10-07. §10 records what planning changed; where it disagrees with an earlier section, §10 wins.
Spec sources: project spec §21 (Phase 11 — "monitoring"), §23 principle 12 ("Every important AI workflow should be observable"); CLAUDE.md §9 ("Do not log resume contents unnecessarily", "Do not expose personal information in debugging output"); DECISIONS.md D9 (PII log scrubbing — decided in Phase 0, never built); architecture §9 ("Structured logging only; no resume/profile content in production logs regardless of scrubbing (defense in depth)"). Follows Phase 11a (D154–D164) and the D165 CI fix; decisions start at **D166**.

## 1. Scope

Phase 11 is split 11a (done) / **11b (this spec)** / 11c (security, rate limiting, index audit) / 11d (automated E2E in CI, docs).

In scope:
- A dependency-free structured logger package with D9 value scrubbing, replacing the four copied worker `log` helpers and every production `console.*` call.
- Catching errors that escape web route handlers: a message-free, scrubbed log line and a 500 with a request id.
- Worker heartbeats, queue health, `GET /api/status` and a `/status` page.

Out of scope: log shipping, rotation or retention (stdout/stderr is the contract); request access logs; pretty-printed dev logs; alerting/notifications; metrics or tracing (Langfuse covers AI calls); multi-tenant redaction (D9's single-user note stands).

## 2. Decisions taken in brainstorming

1. **In-app status page** (not health-JSON-only, not logs-only): workers' heartbeats and per-queue counts on `/status`.
2. **In-repo logger** (`@ai-career/logging`), not pino — D9 is value-based scrubbing, pino's `redact` is path-based, so pino would add a dependency without removing work.
3. **Error messages are never logged.** An `Error` becomes `{ name, code?, frames }`. Messages can carry resume/job text that exact-value scrubbing cannot catch (architecture §9: no content "regardless of scrubbing").
4. **D9 plus one generic email pattern.** Exact, case-insensitive profile values (D9) and an email-address regex (D9 rejected regexes for *names*, which have no reliable pattern; email addresses do).
5. **`withRouteErrors` on every route export**, not `onRequestError` alone: Next.js still prints the raw error itself when an error escapes a handler (`onRequestError` only observes), so errors must be caught inside the routes.
6. **No home-page badge for status** — a stopped optional worker is normal.

## 3. `@ai-career/logging` (new package `packages/logging`)

### 3.1 API

```ts
type LogLevel = "debug" | "info" | "warn" | "error";
interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
createLogger(opts: { service: string; level?: LogLevel; redactor?: Redactor; write?: (line: string, level: LogLevel) => void }): Logger
```

- One JSON line per call: `{ "ts": ISO-8601, "level", "service", "event", ...fields }` (fields cannot override those four keys — they are written last-wins in favour of the logger's own).
- `warn`/`error` → stderr, `debug`/`info` → stdout (default `write`; injectable for tests).
- Below the configured level → nothing written. `level` defaults to `info`; services pass `env.LOG_LEVEL`.
- Never throws: a field that cannot be serialized (cycle, BigInt) is replaced by `"[unserializable]"`.

### 3.2 Field sanitizing (`sanitize`)

Applied to every field value, recursively to depth 3 (deeper → `"[depth]"`), arrays capped at 50 items (`"[+N more]"` appended):
- **string** → redactor applied, then truncated to 500 chars with `…[truncated]`.
- **number / boolean / null** → unchanged; `undefined` keys dropped; `bigint` → string; `Date` → ISO string.
- **Error** (or any object with `name` + `stack`) → `{ name, code?, frames }`:
  - `name`: the error's `name` (e.g. `PostgresError`, `TypeError`, `MatchingError`).
  - `code`: only if a string matching `^[A-Za-z0-9_:.-]{1,40}$` (Postgres SQLSTATE `23505`, Node `ECONNREFUSED`, our codes). Anything else dropped.
  - `frames`: up to 8 stack frames as `file:line:col`, paths relative to the repo root (absolute prefix removed), `node:internal` / `node_modules` frames dropped. The stack's first line (which holds the message) is never used.
  - **`message` is never emitted.** Neither is `cause` (its name is appended as `causeName` when it is an Error).
- **plain object** → keys kept, values sanitized. Keys are not scrubbed (they are code-defined).
- **function / symbol** → dropped.

### 3.3 `Redactor` (D9)

```ts
class Redactor { setValues(values: string[]): void; redact(text: string): string }
```
- Exact, case-insensitive substring replacement of each value with `[REDACTED]`; values are trimmed; values shorter than 3 chars are ignored; longer values are replaced first (so a full name wins over a substring of it).
- Plus one email pattern (`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`) → `[REDACTED_EMAIL]`.
- Regex metacharacters in values are escaped. Works with an empty value set (email pattern only).

### 3.4 Where the values come from

`packages/db`: `loadRedactionValues(db, userId): Promise<string[]>` — reads `candidate_profiles` (`full_name`, `email`, `phone_number`, `address_line1`, `linkedin_url`) under `withUserContext`; missing profile → `[]`.

`@ai-career/logging`: `createRedactionRefresher(redactor, load: () => Promise<string[]>, { maxAgeMs = 60_000 })` with:
- `refresh(): Promise<void>` — loads and sets values; a failed load keeps the previous values and is not thrown (logged once as `redaction_refresh_failed` with the error's name only).
- `refreshIfStale(): Promise<void>` — refreshes only when older than `maxAgeMs` (concurrent callers share one in-flight load).
- `startInterval(ms)` → returns `stop()`; the timer is `unref()`'d.

Workers: `await refresher.refresh()` at startup, then `startInterval(60_000)`. Web: a module-level redactor/refresher; `withRouteErrors` awaits `refreshIfStale()` before writing its error line (errors are rare; the first one after boot is still scrubbed).

### 3.5 Migrations of existing logging

- `services/{job-ingestion,matching-worker,maintenance-worker,browser-worker}/src/main.ts`: delete the local `log` / `safeErrorLabel`; use `createLogger({ service })`. Event names are unchanged. Error fields that were `safeErrorLabel(error)` become `error` (sanitized `{ name, code?, frames }`) — except where an existing `MatchingError` / `UnrecoverableError` *message* was deliberately logged as a code (job-ingestion and matching `safeErrorLabel` return `error.message` for those classes): those keep the code as `errorClass: <message>` because those messages are our own error classes, never content.
- `services/maintenance-worker/src/runOnce.ts`, `packages/ai/src/usage/track.ts` (`ai_usage_record_failed`), `apps/web/src/lib/insights/responseModel.ts` (`response_model_failed`): move to the logger, same event names and fields.
- `LOG_LEVEL` (`debug|info|warn|error`, default `info`) and `STATUS_STALE_AFTER_MS` (integer ≥ 1000, default 90 000) added to `packages/config` env; blank = default.
- A structural test (`packages/logging/src/noConsole.test.ts`) fails if any production source under `apps/`, `services/`, `packages/` (excluding tests, `eval`, `e2e`, `test`, `testing`, `fixtures`, build output, and `packages/logging` itself) contains `console.`. Client components (`"use client"` files) are included — none log today.

## 4. Catching errors that escape web routes

### 4.1 `withRouteErrors`

`apps/web/src/lib/http/withRouteErrors.ts`:
```ts
export function withRouteErrors<A extends unknown[]>(route: string, handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response>
```
- `route` is the route's file pattern, passed explicitly (e.g. `"/api/matches/[jobId]"`) — Next does not expose it to handlers.
- On a thrown error (the handler's own deliberate responses are untouched):
  1. `requestId` = 8 lowercase hex chars from `crypto.randomUUID()`.
  2. `await refresher.refreshIfStale()` (never throws).
  3. `log.error("request_failed", { requestId, method, route, path, error })` — `method` and `path` from the `Request` (first argument) if present; `path` is the URL pathname only (query string dropped), scrubbed by the sanitizer.
  4. Return `Response.json({ error: "Something went wrong (request <id>). Details are in the server log.", requestId }, { status: 500, headers: { "x-request-id": <id> } })`.
- If logging itself throws, the 500 is still returned.

Every exported HTTP-method handler (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) in all 40 `apps/web/src/app/api/**/route.ts` files is wrapped. Handler bodies do not change.

### 4.2 Guard test

`apps/web/src/lib/http/allRoutesWrapped.test.ts`: reads every `route.ts`, and fails if any `export async function (GET|POST|PUT|PATCH|DELETE)` remains, or any `export const (GET|…) =` is not `withRouteErrors("<pattern>", …)` with the pattern equal to the file's path (`/api/...`, `[param]` segments kept).

### 4.3 `instrumentation.ts`

`apps/web/src/instrumentation.ts` exports `onRequestError(err, request, context)`: logs `render_failed` with `{ path (pathname only), method, routePath: context.routePath, routeType: context.routeType, error }`, same sanitizer. Known gap (documented): Next.js still prints its own line for those (render) errors; our pages are client components fetching our own (wrapped) routes, so this path is rare.

## 5. Monitoring — `@ai-career/monitoring` (new package `packages/monitoring`)

### 5.1 Heartbeats

```ts
type WorkerName = "job-ingestion" | "matching" | "maintenance" | "browser";
startHeartbeat(redis: Redis, worker: WorkerName, opts?: { intervalMs?: number; now?: () => Date }): { stop(): Promise<void> }
```
- Key `careerpilot:worker:<worker>`, value JSON `{ startedAt, beatAt, pid, stoppedAt: null }`, written immediately and every `intervalMs` (default 30 000) by an `unref()`'d timer. No TTL.
- `stop()`: clears the timer and writes the value with `stoppedAt = now`. Write failures are logged (`heartbeat_failed`, error name only) and never thrown.
- Each worker starts it after its Worker is ready and calls `stop()` in its SIGINT/SIGTERM shutdown before closing the connection.

### 5.2 Reading status

```ts
readWorkerStatus(redis, now, opts?: { staleAfterMs?: number }): Promise<WorkerStatus[]>
// { worker, optional: boolean, state: "running" | "stopped" | "stale" | "never_seen", startedAt, lastSeenAt, stoppedAt }
readQueueStatus(connection, queueNames): Promise<QueueStatus[]>
// { queue, waiting, active, delayed, failed, lastFailedAt: string | null, lastFailedCode: string | null }
```
- State rules (`staleAfterMs` = env `STATUS_STALE_AFTER_MS`, integer ≥ 1000, default 90 000; lowering it is how the E2E observes "stale" quickly): no key → `never_seen`; `stoppedAt` set and ≥ `beatAt` → `stopped`; `now − beatAt ≤ staleAfterMs` → `running`; otherwise `stale`. A malformed value → `stale` with nulls.
- `optional` is true for `maintenance` and `browser`.
- Queue counts via BullMQ `Queue.getJobCounts("waiting","active","delayed","failed")`; the last failed job via `getFailed(0, 0)` → `finishedOn` as ISO; `lastFailedCode` = its `failedReason` **only if** it matches `^[a-z_]+(:[a-z0-9_]+)?$`, else `null`.
- Queues: `job-ingestion`, `matching`, `maintenance`, `browser-automation` (the existing `*_QUEUE_NAME` constants; the maintenance constant moves from the worker into `@ai-career/monitoring`'s queue list by value, not import, to avoid a services→packages inversion).

### 5.3 `GET /api/status`

`apps/web/src/app/api/status/route.ts` (wrapped): `{ checkedAt, database: "ok"|"unavailable", redis: "ok"|"unavailable", workers: WorkerStatus[], queues: QueueStatus[] }`. Always 200. Every Redis/DB operation has a 5 s timeout; on Redis failure `redis: "unavailable"`, `workers: []`, `queues: []`; connections are always closed (same pattern as `apps/web/src/lib/*/enqueue.ts`).

### 5.4 `/status` page

`apps/web/src/app/status/page.tsx` + `StatusClient.tsx`:
- Workers table: Worker, State (badge: running green / stopped grey / stale amber / never seen grey), Last seen (`12 s ago`, `3 min ago`, `2 h ago`, `—`), Started (UTC `YYYY-MM-DD HH:MM`), and an "optional" tag for maintenance and browser.
- Queues table: Queue, Waiting, Active, Delayed, Failed, Last failure (`YYYY-MM-DD HH:MM` + code, or "see the worker log" when the reason was withheld, or `—`).
- Notes: "Failed counts include only the failed jobs each queue keeps, not a lifetime total." and, when Redis is unavailable, "Redis is unavailable, so worker and queue status cannot be read."
- Auto-refresh every 30 s plus a "Refresh" button; the newest response wins.
- Home page: link `9. System status — workers and queues` after `8. AI usage`. No badge.

## 6. Configuration

```
# Phase 11b. Minimum log level: debug | info | warn | error (default info).
# LOG_LEVEL=info
# Milliseconds without a heartbeat before /status calls a worker "stale" (workers beat every 30 s). Minimum 1000.
# STATUS_STALE_AFTER_MS=90000
```

## 7. Testing

- `@ai-career/logging`: line shape and stream routing; level filtering; reserved keys win; sanitize for every type (depth, array cap, truncation, Date, bigint, cycles); Error → name/code/frames with a sentinel message that never appears, code allowlist, frame trimming; Redactor (case-insensitive, longest first, metacharacters, short values ignored, email pattern, empty set); refresher (stale/not stale, shared in-flight, failed load keeps old values); `noConsole` guard.
- `packages/db`: `loadRedactionValues` (RLS-scoped, missing profile → `[]`) — test user `00000000-0000-0000-0000-000000000c01`.
- `@ai-career/monitoring`: state rules at the 90 s boundary, stopped vs stale, malformed values; heartbeat writes/interval/stop against real Redis with isolated key prefixes; queue status on isolated test queues incl. the failure-reason allowlist.
- Web: `withRouteErrors` (passes through responses, 500 body/header, log line content with a sentinel message and a profile value both absent, refresh awaited, logging failure still 500); `allRoutesWrapped` guard; `/api/status` (ok, Redis down → unavailable and still 200); `StatusClient` rendering; home links.
- Workers: each worker test asserts the heartbeat is started and stopped.
- E2E (real Chrome, `career_intel_test`, web started with `STATUS_STALE_AFTER_MS=5000`): `/status` shows the matching worker running; after the worker is killed with SIGKILL (no clean stop) and 5 s pass, it shows stale; after a clean SIGTERM restart-and-stop it shows stopped. Forced route error, no test-only route: a second web instance is started with `DATABASE_URL` pointing at a closed port, `GET /api/insights` there returns 500 with the request-id body and `x-request-id` header, and that instance's stderr contains a `request_failed` line with the same request id, `error.name`, `error.code` `ECONNREFUSED`, and no `ECONNREFUSED 127.0.0.1` message text.

## 8. Documentation

DECISIONS D166+ (logger design, never logging messages, D9 + email pattern, `withRouteErrors`, heartbeats/status, E2E record); architecture §9 and a new §22; FLOW §17; README status; `.env.example`.

## 9. Risks

- **Over-redaction:** a profile value that is also a common word (e.g. an address line "Main Street") is redacted wherever it appears in logs. Accepted: logs lose a word, never leak a value.
- **Under-redaction:** names in other forms ("Jon" for "Jonathan") are not caught (D9's accepted limit); mitigated by never logging messages or content.
- **Wrapper drift:** a new route without the wrapper — caught by the guard test.
- **Heartbeat clock skew:** workers and web share the host clock (single machine); a container clock drift would show false "stale" — documented.

## 10. Planning refinements (2026-10-07)

Found while writing and dry-running the implementation plan. Each supersedes the earlier text it names.

1. **Process-wide logging settings (§3.1, §3.4).** `configureLogging({ level })` and `defaultRedactor()` hold the process's level and D9 values, read at write time, so loggers that library code creates at import time (`packages/ai`, web's `lib/log.ts`) follow them; a logger's own `level`/`redactor` options still override. `initProcessLogging({ level, load, logger, intervalMs? })` is the one call each long-running process makes: it sets the level, loads the values before returning, refreshes every 60 s and returns a stop function.
2. **Event levels and fields (§3.5).** Failures log at `error`, everything else at `info`. The old `at` field becomes the logger's `ts`. Worker failures log `error` (sanitized) plus, for the ingestion/matching workers' own error classes, `errorClass`.
3. **Worker heartbeat tests (§7).** The worker entry points (`services/*/src/main.ts`) start real workers and have no unit tests. The wiring is pinned by a structural test (`packages/monitoring/src/allWorkersBeat.test.ts`) and exercised by the E2E, instead of "each worker test asserts it starts and stops its heartbeat".
4. **Shutdown runs once (new).** A second SIGINT/SIGTERM (a double Ctrl-C, or dotenv-cli forwarding the signal) re-entered the ingestion, matching and maintenance workers' shutdown; with the awaited `heartbeat.stop()`, the second run closed Redis under the first and the process crashed with an unhandled "Connection is closed". Those three adopt the browser worker's `stopping` guard; the structural test requires it in all four.
5. **`onRequestError` (§4.3).** Next.js also compiles `instrumentation.ts` for the Edge runtime, where the logger's Node streams do not exist (a static import produced a build warning). The logging lives in `apps/web/src/lib/renderErrors.ts` and is imported dynamically only when `NEXT_RUNTIME === "nodejs"`.
6. **Redis in `/api/status` (§5.3).** Opened with `lazyConnect` and connected explicitly before `ping`: with the offline queue disabled, a command sent before the socket is ready is rejected, which made a healthy Redis read as unavailable.
7. **Two route tests change (§4.1).** `/api/career-goal` (active goal missing its constraints) and `/api/job-sources/upload` (storing fails) expected the error to escape; they now assert the 500 body and that the internal detail does not leak. `/api/matches`' test of `response_model_failed` reads the logger's stderr line instead of a `console.error` spy.
8. **Tests and the developer's database (§3.4).** The web test script loads the repo's `.env` (the developer's database). Route tests already mock `loadEnv` with the test database, so a redaction refresh inside them reads the test database; the instrumentation test mocks the refresh. A `vi.mock` in the shared setup file does not apply to other test files here and is not used.
9. **E2E (§7).** No seed data is needed. The script spawns the matching worker itself as one `node --import tsx src/main.ts` process (so SIGKILL/SIGTERM reach the worker, not a wrapper) with the test database, and checks running → stale (after a SIGKILL, `STATUS_STALE_AFTER_MS=5000`) → running → stopped (SIGTERM, exit code 0). The forced route error is an `AggregateError` with `code: "ECONNREFUSED"` (Node tries IPv6 and IPv4); its frames are all Node internals, so `frames` is empty. Test ids: `…0c01`/`…0c02` (DB test), `…0c03` (status route test).
10. **Patch scaffolding.** For the two new packages, the tests patch also carries the package scaffold (`package.json`, `tsconfig.json`, `eslint.config.mjs`) and its `pnpm-lock.yaml` entry, so `pnpm install --frozen-lockfile` and the red test run work before the implementation exists.

