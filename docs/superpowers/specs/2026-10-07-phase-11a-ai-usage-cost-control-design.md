# Phase 11a — AI Usage Observability & Cost Control: Design

Date: 2026-10-07
Status: Approved in brainstorming (sections 1–3) and as a written spec on 2026-10-07. §14 records what planning changed; where it disagrees with an earlier section, §14 wins.
Spec sources: project spec §17 ("Observability — Langfuse Cloud or self-hosted"; "start the application locally without requiring paid SaaS services"), §21 (Phase 11 — Observability & Production Hardening: "Langfuse … retries … cost controls, monitoring"), §23 principles 12 ("Every important AI workflow should be observable") and 13 ("Prefer local/OSS-compatible infrastructure and keep cloud services optional"). Fulfils the unenforced half of DECISIONS.md D8 ("A monthly spend ceiling is enforced via Langfuse alerting").

## 1. Scope

Phase 11 is split into four sub-phases, each with its own spec → plan → implementation cycle:
- **11a (this spec):** AI usage observability + cost control.
- 11b: structured logging with D9 PII scrubbing, worker/queue monitoring.
- 11c: security, rate limiting, index audit.
- 11d: automated E2E tests in CI, documentation pass.

In scope for 11a:
- One tracked path for every Anthropic `messages.create` call (9 call sites) and every Voyage embedding call (4 call sites), recording operation, model, tokens, web searches, latency, estimated cost and outcome — never prompt or response content.
- A hard monthly spend ceiling checked before every call, with a warning threshold.
- Voyage retry with backoff (Anthropic's SDK already retries).
- An optional, metadata-only Langfuse export over HTTP.
- A `/usage` page, `GET /api/usage`, a budget badge on the home page, and a clear "budget reached" message in every AI action panel.

Out of scope (YAGNI): per-operation or daily budgets, email/push alerts, editing the ceiling from the UI, storing prompt/response text, the Langfuse SDK, self-hosting Langfuse in Docker Compose, recording schema-validation failures as a separate outcome.

## 2. Decisions taken in brainstorming

1. **Split Phase 11; 11a first.** D8's ceiling is a documented promise that nothing enforces today, and 11b/11c build on the call wrapper.
2. **Hard block + warning.** At ≥ the warn percent the UI warns; at ≥ 100% every new LLM/embedding call — user-triggered and background — fails fast without contacting the provider.
3. **Local `ai_calls` table is the source of truth; Langfuse is an optional exporter.** The ceiling must work offline and without SaaS; Langfuse v3 self-hosted needs ClickHouse + Redis + S3 + Postgres (too heavy), and a remote-query ceiling would couple all AI availability to an observability tool.
4. **Explicit operation labels**, not inference from `tool_choice.name` (inference breaks silently on a tool rename and does not cover company research, which forces no tool).
5. **$20 default ceiling; 0 = unlimited.**
6. **Unknown models are priced at the most expensive known rate** and flagged, so a model swap can never make spend look like $0.
7. **`outcome` describes transport only** (`ok` / `api_error` / `blocked`). Schema-validation failures stay reported where they already are (each call site's `*ValidationError`).
8. **User-facing error is HTTP 429 `{ error: "ai_budget_exceeded" }`.**

## 3. Architecture

```
call site (prompt + parsing code unchanged)
   │  client.messages.create(params)            embedTexts(env, texts, usage)
   ▼                                              ▼
createTrackedAnthropic(env, sink, operation)    tracked embedding path
   1. gate:  sink.monthSpendUsd() >= ceiling  →  sink.record(blocked) ; throw AiBudgetExceededError
   2. call:  Anthropic SDK (its own 2 retries)   Voyage fetch (≤3 attempts, backoff, retry-after)
   3. cost:  estimateCost(model, usage)
   4. record: sink.record(event)  — failure here is logged (codes only), never thrown
   ▼
AiUsageSink (interface, packages/ai)
   ├─ DbUsageSink (packages/db): INSERT ai_calls / SUM month  (withUserContext, RLS)
   ├─ NoopUsageSink (packages/ai): evals and unit tests
   └─ LangfuseExporter (packages/ai): wraps another sink; after record(), fire-and-forget POST if LANGFUSE_* set
```

### 3.1 `packages/ai/src/usage/` (new module, no DB dependency)

- `types.ts` — `AiOperation` (string union, §3.3), `AiCallEvent`, `AiUsageSink { monthSpendUsd(now: Date): Promise<number>; record(event: AiCallEvent): Promise<void> }`.
- `prices.ts` — price table and `estimateCost(provider, model, usage)` → `{ costUsd, priceKnown }` (§4.2).
- `budget.ts` — `utcMonthStart(now)`, `checkBudget(sink, env, now)` throwing `AiBudgetExceededError` (carries `spentUsd`, `ceilingUsd`, `resetsAt`).
- `trackedAnthropic.ts` — `createTrackedAnthropic(env, sink, operation, deps?)` returns an object structurally satisfying `Pick<Anthropic, "messages">` whose `messages.create` gates, delegates to a real client built with `ANTHROPIC_API_KEY` (or an injected `deps.client` in tests), measures latency, records, and rethrows the provider's original error unchanged after recording `api_error`.
- `anthropicFor.ts` — `type AnthropicFor = (operation: AiOperation) => Pick<Anthropic, "messages">` and `createAnthropicFor(env, sink)`.
- `langfuse.ts` — `withLangfuseExport(sink, env, deps?)` (§6).
- `NoopUsageSink` — `monthSpendUsd` → 0, `record` → no-op.

`createAnthropicClient(env)` stays exported for evals only; production code paths no longer call it (asserted by a grep test over `apps/` and `services/`).

### 3.2 Call-site wiring

Generators keep their `client: Pick<Anthropic, "messages">` parameter — prompt and parsing code does not change. What changes is who builds the client:

| Operation (`AiOperation`) | Generator | Built where |
|---|---|---|
| `resume_extraction` | `extractProfileFromResume` | `POST /api/profile/resume` |
| `career_goal_parse` | `extractCareerGoal` | `POST /api/career-goal/parse` |
| `job_requirements_extraction` | `extractJobRequirements` (via `ensureJobRequirements`) | resume-optimization pipeline |
| `resume_optimization` | `optimizeResume` | resume-optimization pipeline |
| `company_research` | `runCompanyResearch` (via `ensureCompanyResearch`) | application-package pipelines + research refresh route |
| `pitch_generation` | `generatePitch` | pitch pipeline |
| `cover_letter_generation` | `generateCoverLetter` | cover-letter pipeline |
| `interview_prep_generation` | `generateInterviewPrep` | interview-prep pipeline |
| `match_explanation` | `generateMatchExplanation` | `runMatching` (matching-worker) |
| `profile_fact_embedding` | `embedTexts` | `saveConfirmedProfile` (`apps/web/src/lib/profile/saveProfile.ts`) |
| `goal_embedding` | `embedTexts` (via `ensureGoalEmbedding`) | `confirmCareerGoal`, `runMatching` |
| `job_embedding` | `embedTexts` (via `ensureJobEmbeddings`) | `runMatching` |
| `resume_similarity_embedding` | `embedTexts` | resume-optimization pipeline |

Pipelines that use one Anthropic client for several operations (`runResumeOptimization`, `runPitchGeneration`, `runCoverLetterGeneration`, `runInterviewPrepGeneration`, `prepareApplicationContext`, `runMatching`) change their option from `anthropicClient: Pick<Anthropic,"messages">` to `anthropicFor: AnthropicFor` and call `anthropicFor("<operation>")` at each generator call. Tests pass `() => fakeClient`.

`embedTexts(env, texts, usage: { sink: AiUsageSink; operation: AiOperation })` — the third argument is required, so no embedding call can be untracked by omission. Evals pass `NoopUsageSink`.

Web routes and the matching worker build `const sink = withLangfuseExport(new DbUsageSink(db, env.DEFAULT_USER_ID), env)` once per request/process.

### 3.3 Where the budget error surfaces

- **Web AI routes** — 10 routes: `profile/resume`, `profile/confirm`, `profile` (both call `saveConfirmedProfile` → profile-fact embeddings), `career-goal/parse`, `career-goal/confirm` (`confirmCareerGoal` → goal embedding), `resume-optimizations/[jobId]/run`, `application-pitches/[jobId]/run`, `application-pitches/[jobId]/research/refresh`, `cover-letters/[jobId]/run`, `interview-preps/[jobId]/run`: catch `AiBudgetExceededError` → `429 { error: "ai_budget_exceeded", spentUsd, ceilingUsd, resetsAt }`. One shared helper, `budgetExceededResponse(error)`, in `apps/web/src/lib/aiUsage/`.
- **Company research:** it currently turns `Anthropic.APIError` into a cached `failed` result. `AiBudgetExceededError` is not an `APIError`, so it propagates and is **not** cached as a research failure — pinned by a test.
- **Matching worker:** `runMatching` already tolerates a failed explanation (the match is stored without one). A budget block on an explanation is treated the same way; a budget block on goal/job embeddings fails the BullMQ job with the budget error (BullMQ's existing attempts/backoff apply; each retry is itself blocked and recorded until the month resets or the ceiling is raised).
- **UI:** each AI action panel (profile upload, career-goal parse, resume optimization, pitch, research refresh, cover letter, interview prep) shows: "Monthly AI budget reached ($X.XX of $Y.YY). Raise AI_MONTHLY_BUDGET_USD or wait until <resetsAt date>." via one shared `formatBudgetError` helper.

## 4. Cost estimation

### 4.1 Usage extracted per call

Anthropic: `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `server_tool_use.web_search_requests` (missing fields → 0). Voyage: `usage.total_tokens` from the response body (missing → estimate as 0 and mark `price_known=false`).

### 4.2 Price table (`prices.ts`)

USD per million tokens; longest matching model-ID prefix wins (so `claude-haiku-4-5-20251001` matches `claude-haiku-4-5`). Sources: Anthropic model pricing as cached in the claude-api reference (2026-06-24), Anthropic web-search docs, Voyage pricing page (verified 2026-10-07).

| Prefix | Input | Output |
|---|---|---|
| `claude-haiku-4-5` | 1.00 | 5.00 |
| `claude-sonnet-4-6` | 3.00 | 15.00 |
| `claude-sonnet-5` | 2.00 | 10.00 |
| `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5` | 5.00 | 25.00 |
| `claude-opus-5-5` | 4.00 | 20.00 |
| `claude-fable-5` (covers `claude-fable-5-1`) | 10.00 | 50.00 |
| `voyage-3.5` | 0.06 | — |
| `voyage-3.5-lite` | 0.02 | — |

- Cache reads: 0.1 × input rate. Cache writes: 1.25 × input rate (5-minute TTL — the only TTL the app uses).
- Web search: $10 per 1,000 requests ($0.01 each).
- Unknown model: priced at the highest Anthropic (or Voyage) rate in the table, `price_known = false`.
- Stored as `numeric(12,6)`; computed in integer micro-dollars to avoid float drift, then converted.

Costs are **estimates, not the invoice** (the UI says so).

## 5. Budget gate

Config (validated in `packages/config` `loadEnv`):
- `AI_MONTHLY_BUDGET_USD` — non-negative number, default `20`; `0` = unlimited (gate skipped, UI shows "no ceiling").
- `AI_BUDGET_WARN_PERCENT` — integer 1–100, default `80`.

Rules:
- Month = UTC calendar month containing `now`; `resetsAt` = first instant of the next UTC month.
- Before every tracked call: `spent = sink.monthSpendUsd(now)` (SUM of `estimated_cost_usd` for the user since `utcMonthStart(now)`). If ceiling > 0 and `spent >= ceiling` → record a `blocked` row (cost 0, latency 0, tokens 0) and throw `AiBudgetExceededError`. The provider is never contacted.
- **Accepted overshoot:** check-then-call is not atomic; concurrent in-flight calls can push spend past the ceiling by their own cost. For a single user this is cents. Documented, not locked.
- If `monthSpendUsd` itself throws (DB down), the call is **blocked** (fail closed) and the error rethrown — an unenforceable ceiling must not silently become no ceiling.
- If `record` throws after a successful provider call, the result is still returned; the failure is written to stderr as `ai_usage_record_failed operation=<op> code=<pg code>` — no content.

## 6. Langfuse export (optional)

- Enabled only when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_HOST` are all set; `loadEnv` rejects a partial set.
- After the wrapped sink's `record` resolves, POST `{LANGFUSE_HOST}/api/public/ingestion` with HTTP basic auth (public:secret) and body `{ batch: [{ id, timestamp, type: "generation-create", body }] }` where `body` carries: `id` (the `ai_calls` id), `name` (operation), `model`, `startTime`/`endTime`, usage counts, cost, and `metadata: { provider, outcome, errorCode, priceKnown }`. The exact `usageDetails` / `costDetails` field names are pinned against Langfuse's API reference during planning.
- **Never** sends `input`, `output`, prompt text, response text, or any user/profile field. A test asserts a sentinel string in the request params never appears in the exported body.
- Fire-and-forget with a 3 s timeout; not awaited by the caller. Failures (network, non-2xx, a 207 with per-event errors) increment a process-local counter reported by `GET /api/health` as `langfuseExportFailures` (and `langfuseEnabled`). Blocked calls are exported too.

## 7. Voyage retry

`embedTexts` makes up to 3 attempts. Retries on network errors, 429 and 5xx; never on other 4xx. Delay: `retry-after` seconds when present (capped at 30 s), else `500ms × 2^(attempt-1)` with ±20% jitter. Sleep is injectable for tests. One `ai_calls` row per logical `embedTexts` call (final outcome, total latency), not per attempt. The gate runs once, before the first attempt.

Anthropic: unchanged (SDK default `maxRetries: 2`); likewise one row per logical `messages.create`.

## 8. Data model — `ai_calls` (migration 0028)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk default gen_random_uuid() | |
| `user_id` | uuid not null | RLS, D2 |
| `created_at` | timestamptz not null default now() | |
| `operation` | text not null | §3.2 values; not a CHECK (new operations shouldn't need a migration); validated by the TS union |
| `provider` | text not null | CHECK in (`anthropic`, `voyage`) |
| `model` | text not null | |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `web_search_requests` | integer not null default 0 | CHECK ≥ 0 |
| `latency_ms` | integer not null | CHECK ≥ 0 |
| `estimated_cost_usd` | numeric(12,6) not null | CHECK ≥ 0 |
| `price_known` | boolean not null | |
| `outcome` | text not null | CHECK in (`ok`, `api_error`, `blocked`) |
| `error_code` | text null | short code only: SDK error class name + HTTP status (e.g. `RateLimitError:429`), `voyage:<status>`, `network`, `budget_exceeded`. Never an error message body. |

Index `(user_id, created_at DESC)`. RLS enabled with the standard `user_id = current_setting('app.current_user_id')::uuid` policy, granted to `career_intel_app` (SELECT, INSERT only — rows are append-only). Not touched by the retention sweep (no PII, no content).

`DbUsageSink` (`packages/db/src/aiUsage/`) runs both statements through `withUserContext`.

## 9. API and UI

`GET /api/usage` → `{ month: { start, resetsAt }, ceilingUsd | null, warnPercent, spentUsd, state: "unlimited" | "ok" | "warn" | "over", byOperation: [{ operation, calls, blocked, inputTokens, outputTokens, webSearches, costUsd }], byModel: [{ model, calls, costUsd }], unknownPriceModels: string[], recentFailures: [{ createdAt, operation, model, outcome, errorCode }] (last 20 with outcome ≠ ok) }`. Read-only; the aggregation lives in a pure function in `apps/web/src/lib/aiUsage/` over rows fetched for the month.

`/usage` page: spend vs ceiling with a progress bar (and state colour), tables by operation and by model, the unknown-price notice, recent failures, and the note "Costs are estimates from a built-in price table, not your Anthropic/Voyage invoice."

Home page: an "AI usage" link next to the existing nav links; when state is `warn` or `over`, a badge beside it ("82% of AI budget" amber / "AI budget reached" red). No badge when `ok` or `unlimited`. (The app has no global header — nav lives on the home page.)

## 10. Testing

Unit (`packages/ai`):
- prices: prefix match (longest wins), dated model IDs, unknown model → max rate + `priceKnown=false`, cache read/write math, web-search cost, Voyage cost, micro-dollar rounding.
- budget: month start/reset at boundaries, under / exactly at / over ceiling, `0` = unlimited, `monthSpendUsd` throwing → blocked + rethrow.
- tracked Anthropic: ok row has correct usage/latency/cost/operation; provider error → `api_error` row with code + original error rethrown; blocked never reaches the fake client; `record` failure does not fail the call.
- Voyage: 429→ok (2 attempts, 1 row), 500×3 → `api_error`, 400 not retried, `retry-after` honoured (injected sleep), gate once.
- Langfuse: disabled when unset; partial env rejected; payload shape; sentinel content never present; failure counted, never thrown; not awaited.

DB (`packages/db`): `ai_calls` RLS isolation (test id per the existing reserved-id convention, chosen in planning); `DbUsageSink` SUM across a month boundary; app role cannot UPDATE/DELETE.

Wiring:
- each web AI route: operation label lands in `ai_calls`; exhausted budget → 429 `ai_budget_exceeded`.
- `runMatching`: blocked explanation → match stored without explanation; blocked job embedding → job fails with the budget error.
- company research: budget error propagates and nothing is cached.
- grep test: no `createAnthropicClient(` in `apps/` or `services/` production code.

UI: `/usage` renders empty / ok / warn / over / unlimited / unknown-price; home badge thresholds; each AI panel renders the budget message on 429.

E2E (real Chrome, built app, existing fake Anthropic + fake Voyage): parse a goal, run matching, prepare a job → `/usage` shows rows per operation; set `AI_MONTHLY_BUDGET_USD` just under current spend, restart → next action shows the budget message, home shows the red badge, a `blocked` row exists. Recorded as a DECISIONS entry like previous phases.

## 11. Configuration additions (`.env.example`)

```
# Phase 11a AI cost control. Monthly ceiling in USD on estimated AI spend (0 = no ceiling).
# AI_MONTHLY_BUDGET_USD=20
# Percent of the ceiling at which the app starts warning (1-100).
# AI_BUDGET_WARN_PERCENT=80
# Optional Langfuse export (metadata only, never prompt/response text). Set all three or none.
# LANGFUSE_HOST=https://cloud.langfuse.com
# LANGFUSE_PUBLIC_KEY=
# LANGFUSE_SECRET_KEY=
```

CI sets none of the Langfuse vars and leaves the ceiling at its default (fakes report small usage).

## 12. Documentation

- DECISIONS.md, starting at D154: local-first usage store + optional Langfuse (supersedes D8's "via Langfuse alerting"); hard ceiling, fail-closed gate and accepted overshoot; conservative unknown-model pricing; transport-only outcome; Langfuse over HTTP without SDK and metadata-only; per-operation `anthropicFor` factory; Voyage retry policy; E2E record.
- `docs/architecture.md`: new §21; fix §7's "Monthly spend ceiling enforced via Langfuse alerting"; status line.
- FLOW.md: new section for the tracked call path.
- README: AI budget + optional Langfuse setup.

## 13. Risks

- **Price table drift.** Prices change; the table is code. Mitigation: unknown models priced high; prices sourced and dated in `prices.ts`; the UI labels costs as estimates.
- **Per-call SUM query.** Matching explains up to 25 jobs per run → 25 extra indexed SUMs; negligible at single-user volume, revisit if a run's explanation count grows.
- **Factory signature churn.** Six pipelines and their tests change one option. Mechanical; done per package so each task stays reviewable.
- **Background block surprises.** Once over budget, matching keeps producing unexplained matches and embedding jobs fail until the month resets — visible on `/usage` and the home badge, which is the intended trade-off of a hard ceiling.

## 14. Planning refinements (2026-10-07)

Found while writing and dry-running the implementation plan. Each supersedes the earlier text it names.

1. **Langfuse transport (§6).** Langfuse's OpenAPI document marks `POST /api/public/ingestion` deprecated and shut down on Langfuse Cloud on 2026-11-16 for everything but scores. The exporter instead POSTs one OTLP/HTTP JSON span per call to `{LANGFUSE_HOST}/api/public/otel/v1/traces` with basic auth and `x-langfuse-ingestion-version: 4`, using Langfuse's documented `langfuse.observation.*` attributes (type `generation`, model, `usage_details`, `cost_details`, level, metadata). Still a plain `fetch`, still metadata only.
2. **Embeddings under a budget block (§3.3).** Every embedding call site already swallows errors by design (D56, "degrade, never block"). A blocked embedding is recorded and degrades the same way; it does not fail the matching job, and the profile/goal confirm routes never return 429. `ensureJobEmbeddings` stops at the first blocked chunk (remaining jobs counted as failed).
3. **Matching explanations (§3.3).** The explanation loop stops at the first budget block (`break`) and the run completes with every score stored, instead of recording one blocked row per remaining job.
4. **Which routes answer 429 (§3.3).** Seven: `profile/resume`, `career-goal/parse`, `resume-optimizations/[jobId]/run`, `application-pitches/[jobId]/run`, `application-pitches/[jobId]/research/refresh`, `cover-letters/[jobId]/run`, `interview-preps/[jobId]/run`. Resume upload and goal parse also mark their row failed with `ai_budget_exceeded`.
5. **429 body and UI (§3.3).** Every AI panel already shows the response's `error` string, so the readable message goes in `error` and the body adds `code: "ai_budget_exceeded"`, `spentUsd`, `ceilingUsd`, `resetsAt`. No panel changes; no `formatBudgetError` UI helper. Message: `Monthly AI budget reached ($X.XX of $Y.YY). Raise AI_MONTHLY_BUDGET_USD or wait until YYYY-MM-DD (UTC).`
6. **Generator client type (§3.1, §3.2).** Generators take `MessagesClient` (non-streaming `messages.create` only) instead of `Pick<Anthropic, "messages">`, so untracked `stream`/`countTokens`/`batches` calls do not compile. A real SDK client remains assignable. `createTrackedAnthropic` is not a separate export: `createAnthropicFor(env, sink)` returns `(operation) => MessagesClient`.
7. **Sink interface (§3.1).** `AiUsageSink` is `{ spendSinceUsd(since), record(event) }` (month bounds stay in `packages/ai`). `DbUsageSink` declares its own structurally identical record type so `packages/db` does not depend on `packages/ai`; property-typed members make TypeScript reject drift where the two meet.
8. **Append-only (§8).** Enforced by command-specific RLS policies (`FOR SELECT`, `FOR INSERT`), not grants: the app role holds UPDATE/DELETE on every table via default privileges. Test ids: `…0b01`/`…0b02` (DB tests), `…0b04`/`…0b05` (usage route test), `…0b06` (E2E).
9. **Home badge (§9).** The home page is prerendered at build time, so the link and badge are a client component that fetches `GET /api/usage`. The warn badge shows the floored percentage (`84% of AI budget`); over shows `AI budget reached`.
10. **Voyage errors (§7).** `VoyageRequestError`'s message carries the status only — the response body can echo the embedded text. An HTTP-date `retry-after` falls back to exponential backoff.
11. **Blank env values (§5, §6).** A blank `AI_MONTHLY_BUDGET_USD`/`AI_BUDGET_WARN_PERCENT` uses the default (`z.coerce.number("")` would be 0, i.e. unlimited); a blank `LANGFUSE_*` counts as unset.
12. **E2E (§10).** Runs against `career_intel_test` as user `…0b06` with the existing fake Anthropic (now returning token usage), an invalid Voyage key (Voyage's real 401 exercises failure recording) and a local fake Langfuse OTLP receiver — no real Anthropic, Voyage or Langfuse spend.

