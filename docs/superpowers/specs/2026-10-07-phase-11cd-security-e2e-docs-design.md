# Phase 11c + 11d — Security Hardening, Rate Limiting, Index Audit, CI E2E & Docs: Design

Status: Implemented and merged to main (merge 9e4292f, 2026-10-07); see DECISIONS D177–D183 for what changed during the build and the final review (e.g. `HOST` became `APP_HOST`, the index-audit script became a catalog test, E2E runs inside the existing CI job). Combined spec + task list (one document, at the user's request to minimise overhead).

Spec sources: project spec §21 (Phase 11 — Observability & Production Hardening), CLAUDE.md §9 (privacy/security), §10 (testing), §16 (documentation). Decisions start at D177.

## 1. User choices (2026-10-07)

1. **Access:** listen on 127.0.0.1 by default; an optional `APP_ACCESS_TOKEN` gates every page and API route when set (for LAN/remote use). No accounts (D1 stands).
2. **Rate limiting:** only routes that cost AI money or start background work; Redis fixed window; 429 + `Retry-After`; fail-open when Redis is down (the 11a monthly budget remains the hard stop).
3. **CI E2E:** one Playwright smoke suite in a new CI job, fake Anthropic, covering the main flow plus 11b/11c error paths. Per-phase scripts stay as references.

## 2. Phase 11c — Security

### 2.1 Network binding
`apps/web` `dev`/`start` scripts pass `-H "${HOST:-127.0.0.1}"` (Next defaults to 0.0.0.0). `HOST` documented in `.env.example`; setting `HOST=0.0.0.0` without `APP_ACCESS_TOKEN` logs a `warn` at startup (`exposed_without_token`). The web app is not in docker-compose, so nothing else binds it.

### 2.2 Request gate — `apps/web/src/proxy.ts` (Next 16 Proxy, Node runtime)
Runs on every request except `/_next/static`, `/_next/image`, `favicon.ico`. In order:
1. **Host allowlist (DNS-rebinding defence).** `Host` must be `localhost`, `127.0.0.1`, `[::1]` (any port) or listed in `ALLOWED_HOSTS` (comma-separated). Else 421 `{ error: "Unknown host" }`.
2. **Cross-site writes (CSRF defence).** For `POST/PUT/PATCH/DELETE`: if `Origin` is present and its host differs from `Host`, 403 `{ error: "Cross-site request blocked" }`. A missing `Origin` with `Sec-Fetch-Site: cross-site` is also blocked. (Without auth, any website could otherwise POST to localhost and spend the AI budget.)
3. **Access token (only when `APP_ACCESS_TOKEN` is set, ≥ 32 chars, validated by `loadEnv`).** Accepted credentials: cookie `cp_access` = HMAC-SHA256(token, "cp_access_v1") hex, or `Authorization: Bearer <token>`. Constant-time comparison (`timingSafeEqual`). Exempt: `/unlock`, `/api/unlock`, `/api/health`. Failure: `/api/*` → 401 `{ error: "Access token required" }`; pages → 307 to `/unlock?next=<path>` (`next` must be a same-origin relative path, else `/`).
4. `/unlock` page: one password field → `POST /api/unlock { token }`; correct → sets `cp_access` (HttpOnly, SameSite=Strict, Path=/, Secure when the request is https, Max-Age 30 days) and 204; wrong → 401. `/api/unlock` is rate limited (5/min) and logs `unlock_failed` (no token text).

### 2.3 Rate limiting — `apps/web/src/lib/http/rateLimit.ts`
`withRateLimit(bucket, handler)` wraps a route handler *inside* `withRouteErrors`. Redis `INCR careerpilot:rl:<bucket>:<windowStart>` + `PEXPIRE` 60 s (fixed 60 s window, single user → no per-IP key). Over the limit → 429 `{ error: "Too many requests — try again in N s.", retryAfterSeconds }` + `Retry-After`. Redis unavailable (shared fail-fast connection, 500 ms timeout) → allow and log `rate_limit_unavailable` through `throttleErrorLog`. Limits: `RATE_LIMIT_AI_PER_MINUTE` (default 10) for AI routes, `RATE_LIMIT_JOBS_PER_MINUTE` (default 20) for enqueue/upload routes; `0` disables.
- AI buckets: `career-goal/parse`, `profile/resume` (POST, extraction), `resume-optimizations/[jobId]/run`, `cover-letters/[jobId]/run`, `application-pitches/[jobId]/run`, `application-pitches/[jobId]/research/refresh`, `interview-preps/[jobId]/run`.
- Job buckets: `matches/run`, `job-sources/[id]/run`, `job-sources/upload`, `automation-sessions` (POST).
- Guard test `rateLimitedRoutes.test.ts` pins this list (like `allRoutesWrapped.test.ts`).

### 2.4 Security headers — `next.config.ts` `headers()`
All paths: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`. A full script-src CSP is out of scope (needs per-request nonces across the app; documented gap). `poweredByHeader: false`.

### 2.5 Audits (findings fixed, each with a test, recorded in DECISIONS)
- **Input paths:** both upload routes, every `request.json()` route (invalid JSON → 400, size), path params (UUID validation), external-content prompt boundaries. Fix only real findings.
- **Dependencies:** `pnpm audit --prod`; upgrade high/critical where a fix exists, else record.
- **Index audit:** a script (`packages/db/scripts/indexAudit.ts`) lists foreign-key columns without a leading index and runs `EXPLAIN` on the hot list/read queries against a seeded test DB. Missing indexes on hot paths are added in one migration; the rest recorded. A db test asserts every FK column has a covering index (or is on an explicit allowlist with a reason).

## 3. Phase 11d — CI E2E & docs

### 3.1 `e2e/` workspace package
- `e2e/fakeAnthropic.mjs` (moved/generalised from `services/matching-worker/e2e/fakeAnthropic.ts`, tool-keyed responses for every tool the smoke flow calls), `e2e/smoke.mjs` (playwright-core; Chrome from `CHROME_PATH` locally, Playwright's Chromium in CI), `e2e/run.mjs` (starts fake Anthropic, web on 3100 with `APP_ACCESS_TOKEN`, low rate limits, `STATUS_STALE_AFTER_MS=5000`/`HEARTBEAT_INTERVAL_MS=1000`, the matching worker; runs the smoke; always tears down; prints each check as JSON).
- `pnpm e2e` at the root runs it.
- **Smoke checks:** unknown Host → 421; cross-site POST → 403; no token → API 401 and page redirect to `/unlock`; wrong token 401; unlock → home renders; security headers present; seed a profile via `/api/profile/confirm`; parse + confirm a career goal (fake AI); upload a 3-row CSV job source and run it; run matching → a match with an explanation appears on `/matches`; open a job detail and record an application on `/applications`; `/insights`, `/usage`, `/status` (matching worker Running) render; a costly route returns 429 after its limit with `Retry-After`; a forced route error → 500 + request id and a message-free `request_failed` line.
### 3.2 CI
New `e2e` job in `.github/workflows/ci.yml` (same services + MinIO + role provisioning as `test`, `needs: test`): install, migrate, `pnpm --filter web build`, `pnpm --filter e2e exec playwright-core install --with-deps chromium`, `pnpm e2e`. Uploads screenshots + logs as an artifact on failure.
### 3.3 Documentation (describe what is built)
`docs/development.md` (setup, env, running, tests, E2E, troubleshooting), `docs/api.md` (every route: method, purpose, body, responses, rate-limit bucket), `docs/ai-system.md` (each AI operation: inputs, schema, validation/guards, prompt-injection handling, budget/usage, evals), README refresh (feature status, security model, links), `docs/architecture.md` §23, FLOW §18, DECISIONS D177+.

## 4. Tasks (TDD; each ends green: lint 0 warnings, typecheck, build, affected tests)
1. Env: `HOST`, `ALLOWED_HOSTS`, `APP_ACCESS_TOKEN` (≥ 32), `RATE_LIMIT_*`; scripts bind 127.0.0.1; startup warning.
2. `proxy.ts` gate (host, cross-site, token) as a pure `checkRequest()` unit-tested + proxy wiring.
3. `/unlock` page + `/api/unlock`.
4. `rateLimit.ts` + wrap the 11 routes + guard test.
5. Security headers + `poweredByHeader: false` (test reads config).
6. Input-path + dependency audit fixes.
7. Index audit script, migration, FK-index test.
8. `e2e/` package, fake Anthropic, smoke, `pnpm e2e` green locally.
9. CI `e2e` job.
10. Docs + DECISIONS + FLOW + verification (forced full suite, E2E), final whole-branch review, fix pass, merge, push.

## 5. Risks / known gaps
- Fixed-window limit allows up to 2× the limit across a window boundary (acceptable: the budget is the hard stop).
- No script-src CSP (nonce plumbing deferred).
- Token in a cookie on plain http over a LAN is sniffable; documented: use it behind TLS for anything beyond a trusted LAN.
- CI E2E adds ~5 min per push.
