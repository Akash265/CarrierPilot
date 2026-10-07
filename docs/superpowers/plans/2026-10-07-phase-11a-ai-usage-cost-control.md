# Phase 11a — AI Usage Observability & Cost Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every Anthropic and Voyage call (feature, model, tokens, estimated cost, outcome — never content), enforce a hard monthly budget before each call, show spend on `/usage` with a home-page badge, and optionally export the same metadata to Langfuse.

**Architecture:** `packages/ai/src/usage/` owns the sink interface, price table, budget gate, `createAnthropicFor` (one labelled, tracked client per operation) and an OTLP Langfuse exporter; `embedTexts` takes a required `{ sink, operation }`. `packages/db` adds the append-only `ai_calls` table and `DbUsageSink`. Pipelines take `anthropicFor` instead of one client; web routes build the sink per request and answer 429 on a budget block; the matching worker builds it per job. `apps/web` adds `GET /api/usage`, `/usage` and a client-fetched home badge.

**Tech Stack:** TypeScript (ESM, raw-TS workspace packages), Anthropic SDK 0.128, Drizzle/PostgreSQL with RLS, Vitest, Next.js 16 App Router, React 19, Testing Library, Playwright-core (E2E only).

**Spec:** `docs/superpowers/specs/2026-10-07-phase-11a-ai-usage-cost-control-design.md` — read it before starting any task. **§14 (planning refinements) overrides earlier sections where they disagree.**

## How the code in this plan is delivered

The code was written and verified before this plan was committed (draft worktree, then a clean replay from `main`): every task's tests fail before its implementation and pass after it; build, typecheck, lint (0 warnings) and the full suite pass at every task's state; a real-Chrome E2E (18 checks) passes at the end. To keep the implementation byte-identical to what was verified, each task's code ships as patch files next to this plan, applied in order with `git apply --index` from the repository root:

`docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-N-tests.patch` and `task-N-impl.patch` (Tasks 12 and 13 have an impl patch only). The E2E kit is in the sibling `e2e/` directory.

Each task below states what its patches contain (files, behaviour, key signatures) so a reader can review them without opening the patch. **Read both patch files before applying them** — they are the code under review. Do not hand-edit patched files beyond what a review finding requires.

## Global Constraints

- Env (exact): `AI_MONTHLY_BUDGET_USD` number ≥ 0, default `20`, `0` = no ceiling; `AI_BUDGET_WARN_PERCENT` integer 1–100, default `80`; a blank value uses the default. `LANGFUSE_HOST` (http(s) URL), `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`: all three or none (blank = unset).
- Month = UTC calendar month; `resetsAt` = first instant of the next UTC month.
- Gate: before every tracked call, `spent >= ceiling` (ceiling > 0) → record `blocked` (cost 0, latency 0, `error_code` `budget_exceeded`) and throw `AiBudgetExceededError` (message `ai_budget_exceeded`, `name` `AiBudgetExceededError`) without contacting the provider. A failing spend query → record `blocked` with `budget_check_failed` and rethrow (fail closed).
- `outcome` ∈ `ok` | `api_error` | `blocked`. `error_code` is a short code only: `anthropic:<status>`, `anthropic:timeout`, `anthropic:connection`, `anthropic:aborted`, `voyage:<status>`, `network`, `error`, `budget_exceeded`, `budget_check_failed`. Never an error message, prompt or response text — anywhere (rows, logs, Langfuse).
- Operations (exact, `AI_OPERATIONS`): `resume_extraction`, `career_goal_parse`, `job_requirements_extraction`, `resume_optimization`, `company_research`, `pitch_generation`, `cover_letter_generation`, `interview_prep_generation`, `match_explanation`, `profile_fact_embedding`, `goal_embedding`, `job_embedding`, `resume_similarity_embedding`.
- Prices (USD/MTok in/out): `claude-haiku-4-5` 1/5, `claude-sonnet-4-6` 3/15, `claude-sonnet-5` 2/10, `claude-opus-4-6|4-7|4-8|5` 5/25, `claude-opus-5-5` 4/20, `claude-fable-5` 10/50, `voyage-3.5` 0.06, `voyage-3.5-lite` 0.02; cache read 0.1×, cache write 1.25× input; web search $0.01 each; longest prefix that equals the id or is followed by `-`; unknown model → that provider's highest rates, `price_known = false`; whole micro-dollars.
- One `ai_calls` row per logical call (retries inside are not rows). A failed `record` logs exactly `{"event":"ai_usage_record_failed","operation":"<op>","code":"<pg code or unknown>"}` and never fails the call.
- 429 body: `{ ...extra, error: "Monthly AI budget reached ($X.XX of $Y.YY). Raise AI_MONTHLY_BUDGET_USD or wait until YYYY-MM-DD (UTC).", code: "ai_budget_exceeded", spentUsd, ceilingUsd, resetsAt }`.
- Embedding call sites keep D56's degrade rule (a blocked embedding degrades like any Voyage error). Matching stops explaining at the first block; `ensureJobEmbeddings` stops at the first blocked chunk.
- Langfuse: OTLP/HTTP JSON to `{host}/api/public/otel/v1/traces`, `Authorization: Basic base64(public:secret)`, `x-langfuse-ingestion-version: 4`, 3 s timeout, fire-and-forget after the row is written; never `input`/`output` attributes.
- Voyage: ≤ 3 attempts; retry network errors, 429, 5xx; seconds `retry-after` capped at 30 s, else 500 ms × 2^(n−1) × (0.8 + 0.4·random); message `Voyage embeddings request failed: <status>`.
- UI copy (exact): `$X.XX of $Y.YY this month`; `$X.XX this month · no monthly ceiling`; `Over {warnPercent}% of your monthly AI budget.`; `Monthly AI budget reached. New AI calls are blocked until YYYY-MM-DD (UTC) or until AI_MONTHLY_BUDGET_USD is raised.`; `Resets YYYY-MM-DD (UTC).`; `No AI calls yet this month.`; `Costs are estimates from a built-in price table, not your Anthropic or Voyage invoice.`; `Could not load AI usage.`; home link `8. AI usage — estimated spend against your monthly budget`; badges `{floor %}% of AI budget` / `AI budget reached`.
- Test user ids (verified unused repo-wide on 2026-10-07): `00000000-0000-0000-0000-000000000b01`/`…0b02` (DB tests), `…0b04`/`…0b05` (usage route test), `…0b06` (E2E).
- New DECISIONS.md entries: **D154–D163**.
- Commit messages end with exactly (copy literally — never substitute a model name):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
  ```
- Web tests: `pnpm --filter web test -- <paths>` (or `cd apps/web && pnpm test -- <paths>`). Run `pnpm --filter web build` before `pnpm --filter web typecheck` in a fresh worktree and after adding routes. Postgres/Redis/MinIO run locally in Docker; DB tests use `career_intel_test`.
- Run every `git apply` from the repository root.

## Review Focus

Inputs the spec implies but a reader might not expect to be handled; each is pinned by a test in the task named.

1. **A blank `AI_MONTHLY_BUDGET_USD=` line in `.env`** must use the $20 default, never coerce to 0 = unlimited — Task 1 ("treats an empty AI budget value as unset").
2. **The database is down when the gate runs** — the call must be blocked (fail closed), not waved through — Task 3 ("fails closed when the spend query throws").
3. **A configured model with no price entry** must not look free — Task 2 (unknown model priced at the highest rate) and Task 11 (`/usage` names it).
4. **A provider error message that echoes the prompt** (Anthropic message, Voyage response body) must never reach a row, a log line or Langfuse — Task 3 (sentinel never in event/log), Task 4 (no input/output attributes), Task 6 (Voyage message has the status only).
5. **Running out of budget halfway through a matching run** must not fail the run or write one blocked row per remaining job — Task 6 (job-embedding chunks stop) and Task 9 (explanations stop, run completes).

---

### Task 1: Config — AI budget and optional Langfuse settings

**Files:**
- Modify: `packages/config/src/env.ts`, `.env.example`
- Test: `packages/config/src/env.test.ts`

**Interfaces — Produces:** `Env.AI_MONTHLY_BUDGET_USD: number`, `Env.AI_BUDGET_WARN_PERCENT: number`, `Env.LANGFUSE_HOST?: string`, `Env.LANGFUSE_PUBLIC_KEY?: string`, `Env.LANGFUSE_SECRET_KEY?: string`.

**What the patches do:** tests cover defaults, bounds (negative/NaN budget, warn 0/101/80.5 rejected, 0 allowed), blank values falling back to defaults, Langfuse off/complete/partial (the error names each missing variable) and a non-http(s) host. The implementation adds a `blankAsUnset` preprocess, the five fields and a `superRefine` rule "set all of LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, or none of them"; `.env.example` documents them.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-1-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/config && npx vitest run` → FAIL: `Tests  6 failed | 22 passed (28)` (e.g. `expected undefined to be 20`).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-1-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/config test && pnpm --filter @ai-career/config typecheck && pnpm --filter @ai-career/config lint` → 28 passed, no tsc/eslint output.
- [ ] **Step 5: Commit** — `git commit -m "feat(config): AI budget and optional Langfuse settings (Phase 11a)"` (+ trailer).

---

### Task 2: AI usage core — types, price table, budget gate

**Files:**
- Create: `packages/ai/src/usage/types.ts`, `noopSink.ts`, `prices.ts`, `budget.ts`, `index.ts`
- Modify: `packages/ai/src/index.ts` (`export * from "./usage"`)
- Test: `packages/ai/src/usage/prices.test.ts`, `packages/ai/src/usage/budget.test.ts`

**Interfaces — Produces:** `AI_OPERATIONS`, `type AiOperation`, `type AiProvider = "anthropic" | "voyage"`, `type AiCallOutcome`, `interface UsageCounts { inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens; webSearchRequests }`, `interface AiCallEvent extends UsageCounts { id; createdAt: Date; operation; provider; model; latencyMs; estimatedCostUsd: number; priceKnown; outcome; errorCode: string | null }`, `interface AiUsageSink { spendSinceUsd: (since: Date) => Promise<number>; record: (event: AiCallEvent) => Promise<void> }` (property syntax — deliberate, see D159), `ZERO_USAGE`, `NoopUsageSink`, `MODEL_PRICES`, `findPrice(provider, model): ModelPrice | null`, `estimateCostUsd(provider, model, usage): { costUsd; priceKnown }`, `utcMonthStart(now)`, `utcNextMonthStart(now)`, `class AiBudgetExceededError { spentUsd; ceilingUsd; resetsAt: Date }`, `checkBudget(sink, { AI_MONTHLY_BUDGET_USD }, now): Promise<void>`, `budgetState(spentUsd, env): "unlimited" | "ok" | "warn" | "over"`.

**What the patches do:** price tests cover dated ids, longest prefix (`claude-opus-5-5` ≠ `claude-opus-5`), the version boundary (`claude-sonnet-50` unmatched), provider isolation, lite vs base Voyage, cache multipliers, web search, micro-dollar rounding and unknown-model fallback (`claude-future-9` → $60 for 1M/1M, flagged). Budget tests cover UTC month bounds (incl. a time that is still Oct 31 in New York), December rollover, under/at/over the ceiling, 0 = unlimited without querying, a throwing spend query propagating, and `budgetState` thresholds computed without float division (`16 of 20 at 80%` is `warn`).

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-2-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/ai && npx vitest run src/usage/prices.test.ts src/usage/budget.test.ts` → FAIL: `Failed to resolve import "./prices"` / `"./budget"` (no tests run).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-2-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/ai test && pnpm --filter @ai-career/ai typecheck && pnpm --filter @ai-career/ai lint` → all pass (the two new files: 14 + 13 tests).
- [ ] **Step 5: Commit** — `git commit -m "feat(ai): AI usage types, price table and monthly budget gate (Phase 11a)"` (+ trailer).

---

### Task 3: Tracked Anthropic calls — `trackAiCall` and `createAnthropicFor`

**Files:**
- Create: `packages/ai/src/usage/track.ts`, `packages/ai/src/usage/anthropicFor.ts`
- Modify: `packages/ai/src/usage/index.ts`
- Test: `packages/ai/src/usage/anthropicFor.test.ts`

**Interfaces — Consumes:** Task 2. **Produces:** `interface MessagesClient { messages: { create(body: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<Anthropic.Message> } }`, `type AnthropicFor = (operation: AiOperation) => MessagesClient`, `createAnthropicFor(env: { ANTHROPIC_API_KEY; AI_MONTHLY_BUDGET_USD }, sink, deps?: { client?: MessagesClient; clock?: () => number }): AnthropicFor`, `anthropicErrorCode(error): string`, and (internal to the package) `trackAiCall(ctx, call)` with `ctx = { sink, env, operation, provider, model, clock, errorCodeOf }` and `call(): Promise<{ result; usage; usageReported; servedModel? }>`.

**What the patches do:** 13 tests with a fake client and a stepping clock: an ok row (operation, served model, all usage fields, 250 ms latency, $2.02 cost incl. 2 searches, UUID id); per-operation labels over one shared client; pricing by the served model; null cache fields and missing `server_tool_use` → 0; no usage block → `priceKnown: false`; `RateLimitError` → `anthropic:429` row and the same error rethrown; timeout/connection/plain errors coded without messages; blocked at the ceiling with the client never called; fail closed when the spend query throws; 0 ceiling skips the query; a failing `record` still returns the result and logs only the JSON code line; a sentinel prompt/response string never appears in any event; a real SDK client is built when none is injected.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-3-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/ai && npx vitest run src/usage/anthropicFor.test.ts` → FAIL: `Failed to resolve import "./anthropicFor"`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-3-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/ai test && pnpm --filter @ai-career/ai typecheck && pnpm --filter @ai-career/ai lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai): tracked Anthropic calls via createAnthropicFor (Phase 11a)"` (+ trailer).

---

### Task 4: Optional Langfuse export over OTLP

**Files:**
- Create: `packages/ai/src/usage/langfuse.ts`
- Modify: `packages/ai/src/usage/index.ts`
- Test: `packages/ai/src/usage/langfuse.test.ts`

**Interfaces — Consumes:** Task 2. **Produces:** `type LangfuseEnv`, `isLangfuseConfigured(env): boolean`, `withLangfuseExport(inner: AiUsageSink, env: LangfuseEnv, deps?: { fetchFn?; timeoutMs? }): AiUsageSink` (returns `inner` unchanged when unconfigured), `buildOtlpPayload(event)`, `getLangfuseExportFailures(): number`, `resetLangfuseExportFailures()`.

**What the patches do:** tests pin the OTLP payload (trace id = row id without dashes, span id = its first 16 hex chars, name = operation, nanosecond start/end, status 1/2, `service.name` `careerpilot`), the Langfuse attributes (JSON-string `usage_details`/`cost_details`, level `DEFAULT`/`WARNING`/`ERROR`, metadata, no `input`/`output`/`prompt`/`completion` keys), the request (URL with a trailing-slash host, basic auth, `x-langfuse-ingestion-version: 4`), recording before exporting, not awaiting the POST, counting non-2xx / network / timeout failures without throwing, and no export when the inner record throws. The implementation uses `BigInt(...) * BigInt(1_000_000)` (no BigInt literal: `apps/web` targets below ES2020) and cancels unused response bodies.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-4-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/ai && npx vitest run src/usage/langfuse.test.ts` → FAIL: `Failed to resolve import "./langfuse"`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-4-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/ai test && pnpm --filter @ai-career/ai typecheck && pnpm --filter @ai-career/ai lint` → all pass (12 langfuse tests).
- [ ] **Step 5: Commit** — `git commit -m "feat(ai): optional metadata-only Langfuse export over OTLP (Phase 11a)"` (+ trailer).

---

### Task 5: `ai_calls` table and `DbUsageSink`

**Files:**
- Create: `packages/db/src/schema/aiCalls.ts`, `packages/db/migrations/0028_medical_maria_hill.sql`, `packages/db/migrations/0029_ai_calls_rls.sql`, `packages/db/migrations/meta/0028_snapshot.json`, `packages/db/migrations/meta/0029_snapshot.json`, `packages/db/src/aiUsage/dbUsageSink.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/index.ts`, `packages/db/migrations/meta/_journal.json`, `packages/db/package.json` (`db:generate:custom:ai-calls-rls` script)
- Test: `packages/db/src/aiCallsTable.rls.test.ts`

**Interfaces — Produces:** `schema.aiCalls`; `interface AiCallRecord` (same shape as `AiCallEvent`, `operation: string`); `class DbUsageSink(db, userId)` with property functions `spendSinceUsd(since): Promise<number>` and `record(event: AiCallRecord): Promise<void>` (each in its own `withUserContext`).

**What the patches do:** 0028 is the drizzle-generated table (columns per spec §8, CHECKs `ai_calls_provider_valid`, `ai_calls_outcome_valid`, `ai_calls_counts_non_negative`, `ai_calls_cost_non_negative`, index `ai_calls_user_created_idx (user_id, created_at DESC)`); 0029 enables RLS with `ai_calls_select` (`FOR SELECT`) and `ai_calls_insert` (`FOR INSERT`) policies only. Tests (users `…0b01`/`…0b02`): isolation, an inclusive `since` boundary summed per user, an empty sum of 0, UPDATE/DELETE by the app role returning no rows, an insert claiming another user rejected by RLS, each CHECK, and ten `$0.000001` rows summing to exactly `0.00001`.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-5-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/db && npx vitest run src/aiCallsTable.rls.test.ts` → FAIL: `Failed to resolve import "./aiUsage/dbUsageSink"`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-5-impl.patch`
- [ ] **Step 4: Run tests, typecheck, lint** — `pnpm --filter @ai-career/db test -- src/aiCallsTable.rls.test.ts && pnpm --filter @ai-career/db typecheck && pnpm --filter @ai-career/db lint` → 7 passed. Then migrate the dev database: `pnpm --filter @ai-career/db db:migrate`.
- [ ] **Step 5: Commit** — `git commit -m "feat(db): append-only ai_calls table and DbUsageSink (Phase 11a)"` (+ trailer).

---

### Task 6: Track every Voyage embedding call, with retry

**Files:**
- Modify: `packages/ai/src/embeddings.ts`, `packages/ai/src/index.ts`, `packages/matching/src/embeddings/ensureGoalEmbedding.ts`, `packages/matching/src/embeddings/ensureJobEmbeddings.ts`, `packages/matching/src/pipeline/runMatching.ts`, `packages/resume-optimization/src/pipeline/runResumeOptimization.ts`, `apps/web/src/lib/profile/saveProfile.ts`, `apps/web/src/lib/career-goal/saveCareerGoal.ts`, `apps/web/src/app/api/resume-optimizations/[jobId]/run/route.ts`, `services/matching-worker/src/worker.ts`, `services/matching-worker/src/main.ts`
- Create: `apps/web/src/lib/aiUsage/createUsageSink.ts`
- Test: `packages/ai/src/embeddings.test.ts`, `packages/matching/src/embeddings/ensureGoalEmbedding.test.ts`, `packages/matching/src/embeddings/ensureJobEmbeddings.test.ts`, `packages/matching/src/pipeline/runMatching.test.ts`, `packages/resume-optimization/src/pipeline/runResumeOptimization.test.ts`, `services/matching-worker/src/worker.test.ts`, `apps/web/src/app/api/profile/confirm/route.test.ts`, `apps/web/src/app/api/profile/route.test.ts`, `apps/web/src/app/api/career-goal/confirm/route.test.ts`

**Interfaces — Consumes:** Tasks 2–5. **Produces:** `embedTexts(env & { AI_MONTHLY_BUDGET_USD }, texts, usage: { sink; operation }, deps?: { fetchFn?; sleep?; random?; clock? })`; `class VoyageRequestError { status }`; `ensureGoalEmbedding(tx, env, constraintsId, usageSink)`; `ensureJobEmbeddings(tx, env, jobIds, usageSink)`; `RunMatchingOptions.usageSink` and `RunMatchingEnv.AI_MONTHLY_BUDGET_USD`; `RunResumeOptimizationOptions.usageSink` and `RunResumeOptimizationEnv.AI_MONTHLY_BUDGET_USD`; `createUsageSink(db, env): AiUsageSink` (web); `MatchingWorkerDeps.usageSinkFor(userId)` (replaced by `aiFor` in Task 9).

**What the patches do:** `embedTexts` goes through `trackAiCall` (one budget check, ≤ 3 attempts per Global Constraints, `voyage:<status>` / `network` codes, `usage.total_tokens` priced). The embeddings test stubs global `fetch` to throw so it can never reach the network. Every caller passes its sink and operation; `ensureJobEmbeddings` stops at the first blocked chunk; the resume-similarity and goal paths degrade to null on a block. Package tests that `vi.mock("@ai-career/ai")` now spread `importOriginal()` (the new exports must exist under the mock). New tests: labels reach `embedTexts` from each caller, budget blocks degrade/stop as specified, the worker builds a sink for the job's user.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-6-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/ai && npx vitest run src/embeddings.test.ts` → FAIL: `Tests  10 failed | 2 passed (12)` — the old `embedTexts` ignores the injected fetch and hits the stubbed global (`global fetch must not be used in embeddings tests`).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-6-impl.patch`
- [ ] **Step 4: Run the touched suites, build, typecheck, lint** — `pnpm --filter @ai-career/ai test && pnpm --filter @ai-career/matching test && pnpm --filter @ai-career/resume-optimization test && pnpm --filter @ai-career/matching-worker test && pnpm --filter web test -- src/app/api/profile src/app/api/career-goal/confirm src/app/api/resume-optimizations && pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass, 0 lint warnings.
- [ ] **Step 5: Commit** — `git commit -m "feat: track every Voyage embedding call, with retry (Phase 11a)"` (+ trailer).

---

### Task 7: Resume optimization through labelled tracked clients; 429 on budget

**Files:**
- Modify: `packages/resume-optimization/src/requirements/extractJobRequirements.ts`, `src/optimization/optimizeResume.ts`, `src/requirements/ensureJobRequirements.ts`, `src/pipeline/runResumeOptimization.ts`, `apps/web/src/app/api/resume-optimizations/[jobId]/run/route.ts`
- Create: `apps/web/src/lib/aiUsage/budgetResponse.ts`
- Test: `packages/resume-optimization/src/pipeline/runResumeOptimization.test.ts`, `apps/web/src/lib/aiUsage/budgetResponse.test.ts`, `apps/web/src/app/api/resume-optimizations/[jobId]/run/route.test.ts`, `apps/web/src/test/jobsDb.ts` (helpers)

**Interfaces — Consumes:** Tasks 3, 6. **Produces:** generators/`ensureJobRequirements` take `MessagesClient`; `RunResumeOptimizationOptions.anthropicFor: AnthropicFor` (replaces `anthropicClient`); `budgetExceededBody(error, extra?)`, `budgetExceededResponse(error, extra?)` (status 429); test helpers `insertAiSpend(admin, userId, usd)`, `aiCallRows(admin, userId)`; `wipeMatchingData` also deletes the user's `ai_calls`.

**What the patches do:** the pipeline asks for `job_requirements_extraction` and `resume_optimization` clients; a budget block propagates unchanged (not mapped to `unknown`). The route builds one sink, passes `anthropicFor` + `usageSink`, and answers 429 via `budgetExceededResponse`. Tests: each generator receives its labelled client, the block propagates, the body helper's exact message/fields, and the route answering 429 with a recorded `job_requirements_extraction` blocked row once seeded spend reaches a $5 ceiling.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-7-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/resume-optimization && npx vitest run src/pipeline` → FAIL: `Tests  1 failed | 14 passed (15)` (`expected undefined to be {}` — the pipeline still passes `anthropicClient`, not labelled clients). The web tests in this patch also fail (`./budgetResponse` does not resolve).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-7-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — `pnpm --filter @ai-career/resume-optimization test && pnpm --filter web test -- src/lib/aiUsage src/app/api/resume-optimizations && pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: resume optimization through labelled tracked clients; 429 on budget (Phase 11a)"` (+ trailer).

---

### Task 8: Pitch, research, cover letter and interview prep through tracked clients; 429 on budget

**Files:**
- Modify: `packages/application-package/src/research/runCompanyResearch.ts`, `src/research/ensureCompanyResearch.ts`, `src/pitch/generatePitch.ts`, `src/coverLetter/generateCoverLetter.ts`, `src/interviewPrep/generateInterviewPrep.ts`, `src/pipeline/prepareApplicationContext.ts`, `src/pipeline/runPitchGeneration.ts`, `src/pipeline/runCoverLetterGeneration.ts`, `src/pipeline/runInterviewPrepGeneration.ts`; `apps/web/src/app/api/application-pitches/[jobId]/run/route.ts`, `.../research/refresh/route.ts`, `apps/web/src/app/api/cover-letters/[jobId]/run/route.ts`, `apps/web/src/app/api/interview-preps/[jobId]/run/route.ts`
- Test: the three `run*Generation.test.ts`, the four route tests, `apps/web/src/test/jobsDb.ts` (helpers)

**Interfaces — Consumes:** Tasks 3, 7. **Produces:** `PrepareApplicationContextOptions.anthropicFor` and `RunPitchGenerationOptions.anthropicFor` (replace `anthropicClient`); `ensureCompanyResearch(db, userId, client: MessagesClient, env, job, opts)`; test helpers `insertResumeEvidence(admin, userId)`, `wipeResumeEvidence(admin, userId)`.

**What the patches do:** labels `company_research`, `job_requirements_extraction`, `pitch_generation`, `cover_letter_generation`, `interview_prep_generation`. Tests: each call receives its labelled client; a budget block from the pitch call or from research propagates and leaves no `company_research` row; each run route answers 429 with a blocked `company_research` row (eligible match + resume evidence + $5 seeded spend); the refresh route drives the real tracked client through a mocked `ensureCompanyResearch` and answers 429.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-8-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/application-package && npx vitest run src/pipeline` → FAIL: `Tests  3 failed | 49 passed (52)` (`expected undefined to be {}` — no labelled clients yet). The route tests in this patch also fail (no 429).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-8-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — `pnpm --filter @ai-career/application-package test && pnpm --filter web test -- src/app/api/application-pitches src/app/api/cover-letters src/app/api/interview-preps && pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: pitch, research, cover letter and interview prep through tracked clients; 429 on budget (Phase 11a)"` (+ trailer).

---

### Task 9: Match explanations through a tracked client; stop explaining at the budget

**Files:**
- Modify: `packages/matching/src/explanation/generateMatchExplanation.ts`, `packages/matching/src/pipeline/runMatching.ts`, `services/matching-worker/src/worker.ts`, `services/matching-worker/src/main.ts`
- Test: `packages/matching/src/pipeline/runMatching.test.ts`, `services/matching-worker/src/worker.test.ts`

**Interfaces — Consumes:** Tasks 3, 6. **Produces:** `RunMatchingOptions.anthropicFor` (replaces `anthropicClient`); `MatchingWorkerDeps.aiFor: (userId) => { usageSink: AiUsageSink; anthropicFor: AnthropicFor }` (replaces `anthropicClient` and `usageSinkFor`).

**What the patches do:** `runMatching` asks for one `match_explanation` client; an `AiBudgetExceededError` breaks the explanation loop and the run still completes. `main.ts` builds `withLangfuseExport(new DbUsageSink(db, userId), env)` and `createAnthropicFor(env, sink)` per job. Tests: the label is requested; with two eligible jobs and `MATCHING_EXPLAIN_TOP_N: 5`, a blocking client is called once, `jobsExplained` is 0 and both scores are stored; the worker calls `aiFor(USER)`.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-9-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/matching && npx vitest run src/pipeline/runMatching.test.ts` → FAIL: `Tests  7 failed | 5 passed (12)` (the tests pass `anthropicFor`, so `anthropicClient` is undefined and runs that reach the explanation step fail).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-9-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — `pnpm --filter @ai-career/matching test && pnpm --filter @ai-career/matching-worker test && pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(matching): match explanations through a tracked client; stop explaining at the budget (Phase 11a)"` (+ trailer).

---

### Task 10: Resume upload and goal parse through tracked clients; guard against untracked calls

**Files:**
- Modify: `packages/ai/src/extractProfile.ts`, `packages/ai/src/extractCareerGoal.ts`, `apps/web/src/app/api/profile/resume/route.ts`, `apps/web/src/app/api/career-goal/parse/route.ts`
- Test: `packages/ai/src/usage/noUntrackedCalls.test.ts`, `apps/web/src/app/api/profile/resume/route.test.ts`, `apps/web/src/app/api/career-goal/parse/route.test.ts`

**Interfaces — Consumes:** Tasks 3, 7.

**What the patches do:** the routes ask for `resume_extraction` / `career_goal_parse` clients; on a budget block they mark the row failed with `ai_budget_exceeded`, do not retry, and answer 429 (`budgetExceededResponse(error, { resumeDocumentId, status: "failed" })` / `{ goalId, version, status: "failed" }`). `noUntrackedCalls.test.ts` walks `apps/`, `services/` and `packages/` production sources (skipping tests, `eval`, `e2e`, `test`, `testing`, `fixtures`, build output) and asserts `createAnthropicClient(` appears only in its definition, `new Anthropic(` only in `extractProfile.ts` and `usage/anthropicFor.ts`, and `api.voyageai.com` only in `embeddings.ts`.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-10-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `cd packages/ai && npx vitest run src/usage/noUntrackedCalls.test.ts` → FAIL: `Tests  1 failed | 3 passed (4)` (`expected [ …(3) ] to deeply equal [ 'packages/ai/src/extractProfile.ts' ]` — the two routes still call `createAnthropicClient(`).
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-10-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — `pnpm --filter @ai-career/ai test && pnpm --filter web test -- src/app/api/profile/resume src/app/api/career-goal/parse && pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: resume upload and goal parse through tracked clients; guard against untracked calls (Phase 11a)"` (+ trailer).

---

### Task 11: `/usage` page, home budget badge, usage API and Langfuse health

**Files:**
- Create: `apps/web/src/lib/aiUsage/summarizeUsage.ts`, `apps/web/src/lib/aiUsage/format.ts`, `apps/web/src/app/api/usage/route.ts`, `apps/web/src/app/usage/page.tsx`, `apps/web/src/app/usage/UsageClient.tsx`, `apps/web/src/app/AiUsageLink.tsx`
- Modify: `apps/web/src/app/page.tsx`, `apps/web/src/app/api/health/route.ts`
- Test: `apps/web/src/lib/aiUsage/summarizeUsage.test.ts`, `format.test.ts`, `apps/web/src/app/api/usage/route.test.ts`, `apps/web/src/app/usage/UsageClient.test.tsx`, `apps/web/src/app/page.test.tsx`, `apps/web/src/app/api/health/route.test.ts`

**Interfaces — Consumes:** Tasks 2, 4, 5. **Produces:** `summarizeUsage(rows: AiCallRow[], env, now): UsageSummary` (`month`, `ceilingUsd | null`, `warnPercent`, `spentUsd`, `state`, `byOperation[{ operation, calls, blocked, failed, inputTokens, outputTokens, webSearches, costUsd }]`, `byModel[{ model, calls, costUsd }]`, `unknownPriceModels`, `recentFailures[≤ 20]`); `formatUsd`, `percentOfCeiling` (floored), `operationLabel`; `GET /api/usage`; health JSON gains `aiUsage: { langfuseEnabled, langfuseExportFailures }` (never affects `status`).

**What the patches do:** see spec §9 and Global Constraints for copy. Tests: micro-dollar sums (ten $0.10 = $1.00), state thresholds, grouping/sorting, blocked calls excluded from `byModel`, unknown-price models listed once, 20 newest failures; the route summarizes only this UTC month for the current user (user `…0b04`, another user `…0b05`, a last-month row) and reports warn/over; the client renders spend/bar/reset/tables/notices/failures/error states; home lists `/usage` last and shows the badge only at warn (floored %) or over, never for ok/unlimited/load errors; health reports Langfuse on/off.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-11-tests.patch`
- [ ] **Step 2: Run it to see it fail** — `pnpm --filter web test -- src/lib/aiUsage src/app/api/usage src/app/usage src/app/page.test.tsx src/app/api/health` → FAIL: `Tests  7 failed | 4 passed (11)` plus unresolved imports (`./UsageClient`, `./summarizeUsage`, `./format`, `./route`): home has no `/usage` link, health has no `aiUsage`.
- [ ] **Step 3: Apply the implementation patch** (repo root) — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-11-impl.patch`
- [ ] **Step 4: Run, build, typecheck, lint** — the same web test command, then `pnpm --filter web build && pnpm typecheck && pnpm lint` → all pass; the build lists `ƒ /api/usage` and `○ /usage`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): /usage page, home budget badge, usage API and Langfuse health (Phase 11a)"` (+ trailer).

---

### Task 12: Documentation — D154–D162, architecture §21, FLOW §16, README

**Files:**
- Modify: `DECISIONS.md`, `docs/architecture.md` (status line, §2 diagram, §7 ceiling line, §8 data-model note, new §21), `FLOW.md` (new §16), `README.md` (Phase 11a status paragraph)

**What the patch does:** documents what Tasks 1–11 built, including the planning corrections (spec §14) and the superseding of D8's "via Langfuse alerting".

- [ ] **Step 1: Apply the patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-12-impl.patch`
- [ ] **Step 2: Check it** — every `[Dnnn]` link in the new architecture text resolves to an entry; `grep -c "^### D15[4-9]\|^### D16[0-2]" DECISIONS.md` → 9.
- [ ] **Step 3: Commit** — `git commit -m "docs: Phase 11a decisions D154-D162, architecture §21, FLOW §16, README"` (+ trailer).

---

### Task 13: Verification and real-browser E2E (D163)

**Files:**
- Modify: `services/matching-worker/e2e/fakeAnthropic.ts` (returns `usage`, `FAKE_INPUT_TOKENS`/`FAKE_OUTPUT_TOKENS`, defaults 1200/300), `DECISIONS.md` (D163)
- Use (not shipped): `docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/e2e/{seed.mts,fakeLangfuse.mjs,e2e.mjs}`

- [ ] **Step 1: Apply the patch** — `git apply --index docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/task-13-impl.patch`
- [ ] **Step 2: CI-order checks** — `pnpm install --frozen-lockfile && pnpm --filter @ai-career/db db:migrate && pnpm lint && pnpm --filter web build && pnpm typecheck && pnpm turbo run test --force` → lint 0 warnings; 17/17 packages pass.
- [ ] **Step 3: E2E stack** (all against `career_intel_test`, user `…0b06`; no real Anthropic/Langfuse spend):
  1. `cd services/matching-worker && PORT=4012 FAKE_INPUT_TOKENS=200000 FAKE_OUTPUT_TOKENS=20000 npx tsx e2e/fakeAnthropic.ts &`
  2. `PORT=4013 CAPTURE_FILE=/tmp/langfuse.jsonl node docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/e2e/fakeLangfuse.mjs &`
  3. `cd apps/web && ../../services/browser-worker/node_modules/.bin/tsx ../../docs/superpowers/plans/2026-10-07-phase-11a-ai-usage-cost-control/e2e/seed.mts`
  4. Export `DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test DEFAULT_USER_ID=00000000-0000-0000-0000-000000000b06 ANTHROPIC_BASE_URL=http://localhost:4012 AI_MONTHLY_BUDGET_USD=0.70 VOYAGE_API_KEY=invalid-e2e-key LANGFUSE_HOST=http://localhost:4013 LANGFUSE_PUBLIC_KEY=pk-lf-e2e LANGFUSE_SECRET_KEY=sk-lf-e2e`, then start `cd apps/web && PORT=3111 pnpm start &` and `cd services/matching-worker && pnpm start &` (dotenv-cli does not override exported variables).
  5. In a scratch directory with `npm install playwright-core`: copy `e2e.mjs`, run `BASE_URL=http://localhost:3111 CAPTURE_FILE=/tmp/langfuse.jsonl node e2e.mjs <screenshot-dir>` → 18 checks `"ok":true`, then `{"done":true}`.
- [ ] **Step 4: Clean up** — stop the four processes; `tsx …/e2e/seed.mts wipe` (from `apps/web`).
- [ ] **Step 5: Record and commit** — D163 (already in the patch) states the verified counts; `git commit -m "test(e2e): fake Anthropic reports token usage; Phase 11a verification D163"` (+ trailer).
