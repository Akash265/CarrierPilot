# Phase 10b — Personal Response Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn, from the user's own decided applications, which match factors have gone with getting a response; show each match's likely response with a 95% range and the factors behind it; offer an opt-in "Rank with my history" ordering; explain the model on `/insights`.

**Architecture:** A deterministic ridge-regularized logistic regression in the pure package `packages/insights` (new `src/model/`), trained on read from 10a's outcome dataset (no tables), gated by a minimum sample and a leave-one-out "beats your average" check. `apps/web` adds a safe loader, personal predictions/ranking in the matches API, a model block in the insights API, and the UI. `packages/matching` gains a dependency-light `./scoring` subpath that `packages/insights` imports instead of matching's root.

**Tech Stack:** TypeScript (ESM, raw-TS workspace packages), Drizzle/PostgreSQL with RLS, Vitest, Next.js 16 App Router, React 19 (`useSyncExternalStore`), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-06-phase-10b-personal-response-model-design.md` — read it before starting any task.

## How the code in this plan is delivered

The code was written and verified before this plan was committed (draft worktree, then a clean replay from `main`): every task's tests fail before its implementation and pass after it; typecheck and lint pass at every task's state; the full suite (17/17 packages, 1829 tests), build and a real-Chrome E2E (11 checks) pass at the end. To keep the implementation byte-identical to what was verified, each task's code is shipped as two patch files next to this plan, applied in order with `git apply --index`:

`docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-N-tests.patch` and `task-N-impl.patch`.

Each task below states what the patches contain (files, behaviour, key signatures) so a reader can review them without opening the patch. **Read both patch files before applying them** — they are the code under review. Do not hand-edit patched files beyond what a review finding requires.

## Global Constraints

- No new database tables or migrations. No LLM, Anthropic or Voyage call anywhere in this phase.
- `packages/insights` imports matching only through `@ai-career/matching/scoring` (never the root `@ai-career/matching`).
- Target = 10a's **response** tier. Features = the 9 match factor scores (`skillsScore`, `experienceScore`, `locationScore`, `sponsorshipScore`, `roleScore`, `salaryScore`, `industryScore`, `freshnessScore`, `semanticScore`), in `FACTOR_WEIGHTS` order.
- Training rows: non-external records with a `positive`/`negative` response label and an **eligible** snapshot match.
- Scaling: per-factor mean and population sd over non-null values; a factor with < 2 values or sd < 1e-9 is dropped; null → training mean (z = 0).
- Fit: L2 ridge, `λ = 1` on standardized coefficients, intercept unpenalized; Newton–Raphson from zeros; stop when max |step| < 1e-8 or after 50 iterations; deterministic.
- Gate (env): `OUTCOME_MODEL_MIN_DECIDED` integer ≥ 10, default 30; `OUTCOME_MODEL_MIN_PER_CLASS` integer ≥ 3, default 8.
- Honesty check: mean leave-one-out log-loss (probabilities clamped to [1e-6, 1 − 1e-6]) must be **strictly** lower than the base-rate baseline's, else status `no_pattern`.
- Statuses: `insufficient_data` | `no_pattern` | `active`.
- Prediction range: Laplace 95% (`σ(logit ± 1.96 √(xᵀΣx))`). Raises/lowers: contribution `βj·zj` beyond ±0.1 logit units, at most 2 per side, strongest first.
- Factor labels: Skills, Experience, Location, Sponsorship, Role, Salary, Industry, Freshness, Fit (`semanticScore`).
- Blend weight `w = min(0.5, decided / 200)`; blended score `(1 − w) × overall + w × 100 × p`, one decimal; personal order = blended desc, overall desc, job id asc; only the eligible list; `ranking` in the response says which order was used.
- The model must never fail a request: training errors are logged as `{"event":"response_model_failed","error":"<ClassName>"}` only and reported as `no_pattern`.
- Toggle preference: localStorage key `careerpilot.rankWithHistory` (`"1"`/`"0"`), read via `useSyncExternalStore` (server snapshot `false`), in-memory fallback when storage throws. Only the latest `/api/matches` request may update the list.
- UI wording (exact): `Your history: likely response 35% (22–50%)`; `Raises: Skills, Role · Lowers: Freshness`; `Ranked with your history (weight 20%)`; disabled reasons `Needs {minDecided} decided applications with at least {minPerClass} responses and {minPerClass} without. You have {decided} ({responses} with a response).` / `Your history doesn't show a pattern that beats your average yet.`; never "because", "causes", "predicts you will".
- Test user ids for this phase (verified unused repo-wide on 2026-10-06): `00000000-0000-0000-0000-000000000a07` (loader DB test), `…000000000a08` (E2E). Existing route tests keep their own users (`…0000000000c5`, `…0000000000c6`, `…000000000a03`).
- Commit messages end with exactly (copy literally — never substitute a model name):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
  ```
- Web tests: `pnpm --filter web test -- <paths>`. In a fresh worktree run `pnpm --filter web build` once before `pnpm --filter web typecheck`. Postgres/Redis/MinIO run locally in Docker.
- New DECISIONS.md entries start at **D146**.
- Run every `git apply` from the repository root (some verify steps `cd` into a package first — `cd` back before applying).

---

### Task 1: `@ai-career/matching/scoring` subpath

**Files:**
- Create: `packages/matching/src/scoring/index.ts`, `packages/matching/src/scoring/index.test.ts`
- Modify: `packages/matching/package.json` (exports), `packages/matching/src/types.ts` (+`FACTOR_KEYS`), `packages/insights/src/dataset/roleFamily.ts` (import path)

**Interfaces — Produces:** `@ai-career/matching/scoring` exporting `FACTOR_KEYS: (keyof FactorScores)[]` (the 9 keys in `FACTOR_WEIGHTS` order), `FACTOR_WEIGHTS`, `FactorScores`, `WorkMode`, `WorkModePreference`, `Sponsorship`, `computeOverallScore`, `scoreExperience`, `scoreFreshness`, `scoreIndustry`, `scoreLocation`, `scoreRole`, `scoreSalary` (+`SalaryComparisonInput`), `scoreSemantic`, `scoreSkills` (+`SkillMatchDetail`, `SkillsScoreResult`), `scoreSponsorship`.

**What the patches do:** the test walks the import graph from `scoring/index.ts` and asserts every specifier is relative and every reached file is inside `src/scoring/` or is `src/types.ts` (so no Anthropic SDK, `@ai-career/ai`, database or queue can ever be pulled in), and that `FACTOR_KEYS` is the 9 keys in order. The implementation adds the barrel, the `"./scoring": "./src/scoring/index.ts"` export, `FACTOR_KEYS = Object.keys(FACTOR_WEIGHTS)` in `types.ts`, and switches `roleFamily.ts` to `import { scoreRole } from "@ai-career/matching/scoring"`.

- [ ] **Step 1: Apply the test patch**
  Run: `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-1-tests.patch`
- [ ] **Step 2: Run it to see it fail**
  Run: `cd packages/matching && npx vitest run src/scoring/index.test.ts`
  Expected: FAIL — `Failed to resolve import "./index"` (no tests run).
- [ ] **Step 3: Apply the implementation patch**
  Run (repo root): `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-1-impl.patch`
- [ ] **Step 4: Run the tests, typecheck and lint**
  Run: `pnpm --filter @ai-career/matching test -- src/scoring/index.test.ts && pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint && pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck`
  Expected: 2/2 scoring tests pass; insights' existing suite passes (roleFamily now uses the subpath); no tsc/eslint output.
- [ ] **Step 5: Commit**
  ```bash
  git commit -m "feat(matching): dependency-light @ai-career/matching/scoring subpath; insights imports it (Phase 10b)"
  ```

---

### Task 2: Factor scores through the outcome dataset

**Files:**
- Modify: `packages/insights/src/types.ts`, `packages/insights/src/dataset/parseSnapshot.ts`, `packages/insights/src/dataset/buildOutcomeDataset.ts`
- Test: `packages/insights/src/dataset/parseSnapshot.test.ts`, `packages/insights/src/dataset/buildOutcomeDataset.test.ts`, `packages/insights/src/stats/computeInsights.test.ts`

**Interfaces — Produces:** `FactorKey = keyof FactorScores`; `FactorVector = Record<FactorKey, number | null>`; `ParsedSnapshot.factors` and `OutcomeRecord.factors: FactorVector | null` — the eligible snapshot match's 9 scores (each tolerant: non-number → null), `null` when there is no eligible match.

**What the patches do:** tests add factor scores to the v2 fixture and expect them back (`factors: {...}`), expect `factors: null` for ineligible, external and malformed snapshots, add a tolerance case (string/undefined scores → null, others kept), and add `factors` to `buildOutcomeDataset` and `computeInsights` fixtures. The implementation adds the types and reads `FACTOR_KEYS.map(key => num(match[key]))` when `match.eligible === true`.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-2-tests.patch`
- [ ] **Step 2: Run to see it fail** — `cd packages/insights && npx vitest run src/dataset src/stats` → FAIL (the parseSnapshot/buildOutcomeDataset expectations lack `factors`).
- [ ] **Step 3: Apply the implementation patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-2-impl.patch`
- [ ] **Step 4: Verify** — `pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint` → all pass, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(insights): carry the 9 match factor scores through the outcome dataset (Phase 10b)"`

---

### Task 3: Ridge logistic regression, scaling, linear algebra

**Files:**
- Create: `packages/insights/src/model/linearAlgebra.ts`, `fitLogistic.ts`, `prepareFeatures.ts` (+ a `.test.ts` for each)

**Interfaces — Produces:**
- `invert(matrix: readonly (readonly number[])[]): number[][] | null` (Gauss–Jordan, partial pivoting, pivot < 1e-12 → null, input untouched); `multiply(matrix, vector): number[]`.
- `sigmoid(t: number): number` (numerically stable); `fitLogistic(x: number[][], y: number[], lambda: number): LogisticFit | null` with `LogisticFit { intercept: number; coefficients: number[]; covariance: number[][]; iterations: number }` (covariance = inverse penalized Hessian at the optimum, index 0 = intercept); constants `MAX_ITERATIONS = 50`, `STEP_TOLERANCE = 1e-8`.
- `fitScaling(rows: readonly FactorVector[]): FeatureScaling` with `FeatureScaling { keys: FactorKey[]; means: number[]; sds: number[] }`; `standardize(scaling, factors): number[]`; `MIN_STANDARD_DEVIATION = 1e-9`.

**What the patches do:** `fitLogistic.test.ts` checks coefficients and covariance against a **NumPy reference** (10 rows × 2 features; λ = 1 → intercept −0.1368796219, coefficients 0.8771758565 / 0.4672429274 and the full 3×3 covariance, to 8 decimals; λ = 1e-6 → −0.3007815744 / 1.6777005917 / 0.964782967, to 6 decimals — computed independently by Newton iterations to a 1e-14 step with gradient norm ~1e-16), determinism (two fits `toEqual`), finiteness on separable data, and an intercept-only fit (`σ(b0) = 0.75`). Other tests cover inversion (identity check, row swap, singular → null), scaling (population sd, dropped constant/sparse factors, nulls ignored) and standardization (null → 0).

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-3-tests.patch`
- [ ] **Step 2: Run to see it fail** — `cd packages/insights && npx vitest run src/model` → FAIL (`Failed to resolve import "./linearAlgebra"` etc.; no tests run).
- [ ] **Step 3: Apply the implementation patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-3-impl.patch`
- [ ] **Step 4: Verify** — `pnpm --filter @ai-career/insights test -- src/model && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint` → 14/14 pass, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(insights): deterministic ridge logistic regression with Laplace covariance, verified against NumPy (Phase 10b)"`

---

### Task 4: Training gates, predictions, blend, evaluation

**Files:**
- Create: `packages/insights/src/model/trainResponseModel.ts`, `predictResponse.ts`, `testing.ts` (synthetic-history helpers), `trainResponseModel.test.ts`, `predictResponse.test.ts`, `evaluation.test.ts`
- Modify: `packages/insights/src/index.ts` (exports)

**Interfaces — Produces:**
- `trainResponseModel(records: readonly OutcomeRecord[], settings: ModelSettings): ModelResult` with `ModelSettings { minDecided; minPerClass }`, `ModelResult { status: ModelStatus; decided; responses; nonResponses; minDecided; minPerClass; looLogLoss: number | null; baselineLogLoss: number | null; blendWeight: number | null; model: ResponseModel | null }`, `ResponseModel { scaling: FeatureScaling; intercept; coefficients; covariance }`; also `trainingRows`, `blendWeight(decided)`, `fitModel(rows)`, `modelProbability(model, factors)`, `RIDGE_LAMBDA = 1`, `LOG_LOSS_EPSILON = 1e-6`.
- `predictResponse(model, factors: FactorVector): ResponsePrediction` with `ResponsePrediction { probability; low; high; raises: string[]; lowers: string[] }`; `blendedScore(overall, probability, weight)`; `describeFactors(model): FactorEffect[]` (`{ key; label; direction: "higher" | "lower"; oddsRatio }`, by |β| desc); `summarizeModel(result): ModelSummary` (`{ status; decided; responses; nonResponses; minDecided; minPerClass; blendWeight }`); `FACTOR_LABELS`; `CONTRIBUTION_THRESHOLD = 0.1`; `MAX_NAMED_FACTORS = 2`.

**What the patches do:** gates in spec order (insufficient data → leave-one-out vs base rate → active); a fold whose fit fails predicts the baseline for its held-out row. Tests: training-row filtering; blend weight 0.15/0.5/0.5 at 30/100/500; each insufficient cause (too few rows, too few of a class, no varying factor); `active` with both losses and `blendWeight 0.2` at 40 rows; `no_pattern` for random labels; determinism; prediction maths against a hand-built model (probability, exact Laplace range, raises/lowers threshold and cap, null → mean), ranges narrowing with 4× data; `blendedScore(80, 0.3, 0.15) = 72.5`; `describeFactors` order and odds ratios; `summarizeModel`. **Evaluation fixtures** (`evaluation.test.ts`, CLAUDE.md §10 AI evaluation): seeded synthetic histories (deterministic mulberry32) — signal in skills → active, top factor skills; skills+role → top two {role, skills}; negative freshness signal → top factor freshness with direction "lower"; pure noise → `no_pattern`; 12 rows → `insufficient_data`; every case identical across runs.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-4-tests.patch`
- [ ] **Step 2: Run to see it fail** — `cd packages/insights && npx vitest run src/model` → FAIL: the three new suites cannot resolve `./trainResponseModel` / `./predictResponse` (Task 3's 14 tests still pass).
- [ ] **Step 3: Apply the implementation patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-4-impl.patch`
- [ ] **Step 4: Verify** — `pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint` → 38 model tests pass (whole package green), clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(insights): response-model gates with leave-one-out check, predictions, blend and evaluation fixtures (Phase 10b)"`

---

### Task 5: Gate settings and the safe web loader

**Files:**
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`, `.env.example`, `apps/web/src/test/jobsDb.ts`
- Create: `apps/web/src/lib/insights/responseModel.ts`, `responseModel.test.ts`, `loadResponseModel.test.ts`

**Interfaces — Produces:**
- env `OUTCOME_MODEL_MIN_DECIDED` (int ≥ 10, default 30), `OUTCOME_MODEL_MIN_PER_CLASS` (int ≥ 3, default 8).
- `ResponseModelEnv { DEFAULT_USER_ID; OUTCOME_UNDECIDED_DAYS; OUTCOME_MODEL_MIN_DECIDED; OUTCOME_MODEL_MIN_PER_CLASS }`; `LoadedResponseModel { result: ModelResult; summary: ModelSummary }`; `trainResponseModelSafely(records, env): LoadedResponseModel`; `loadResponseModel(db, env, now = new Date()): Promise<LoadedResponseModel>` — any error → logged class name only, `no_pattern`.
- Test helpers in `jobsDb.ts`: `ModelFactorKey`; `insertMatch(..., { factors?: Partial<Record<other 8 factors, number>> })` writes all 9 score columns; `insertModelHistory(adminSql, userId, n = 40)` — `n` decided ingested applications (snapshot v2, eligible match, skills = (i+0.5)/n, other factors fixed permutations, salary null), skills > 0.5 → `screening`, else `rejected`; events: creation (`from_status` null → applied) then applied → final status.

**What the patches do:** env tests for defaults and bounds; `responseModel.test.ts` mocks `trainResponseModel` to throw a `RangeError("secret application text")` and asserts the degraded `no_pattern` result and that the log line is exactly `{"event":"response_model_failed","error":"RangeError"}` with no message text; `loadResponseModel.test.ts` (DB, user `…000000000a07`) asserts `insufficient_data` with no history, then with `insertModelHistory(…, 40)` the summary `{ status: "active", decided: 40, responses: 20, nonResponses: 20, minDecided: 30, minPerClass: 8, blendWeight: 0.2 }` and that `salaryScore` (always null) is dropped.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-5-tests.patch`
- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ai-career/config test` → FAIL (2 new env tests: `expected undefined to be 30`); `pnpm --filter web test -- src/lib/insights` → FAIL (`./responseModel` missing).
- [ ] **Step 3: Apply the implementation patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-5-impl.patch`
- [ ] **Step 4: Verify** — `pnpm --filter @ai-career/config test && pnpm --filter web test -- src/lib/insights && pnpm --filter @ai-career/config typecheck && pnpm --filter web build && pnpm --filter web typecheck && pnpm --filter web lint` → config 21 pass, web 4 pass, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): response-model gate settings and a loader that can never fail a request (Phase 10b)"`

---

### Task 6: Predictions and opt-in personal ranking in the matches API

**Files:**
- Modify: `apps/web/src/lib/matching/serializeMatch.ts`, `apps/web/src/lib/matching/listMatches.ts`, `apps/web/src/app/api/matches/route.ts`, `apps/web/src/app/api/matches/[jobId]/route.ts`
- Test: `apps/web/src/lib/matching/serializeMatch.test.ts`, `apps/web/src/app/api/matches/route.test.ts`, `apps/web/src/app/api/matches/[jobId]/route.test.ts`

**Interfaces — Consumes:** `loadResponseModel` (Task 5), `predictResponse`, `blendedScore`, `ResponseModel`, `ResponsePrediction` (Task 4). **Produces:**
- `MatchView.personal: ResponsePrediction | null` (null for ineligible rows); `toMatchView(row, personal = null)`; `factorVectorOf(row): FactorVector` (numeric strings → numbers).
- `ListMatchesQuerySchema` gains `rank: "default" | "personal"` (default `"default"`; unknown → 400). `listMatches(tx, query, personal: PersonalRanking = { model: null, weight: null }): Promise<MatchListResult>` with `MatchListResult { matches; page; pageSize; total; ranking: "default" | "personal" }`. Personal path only when `eligible && rank === "personal" && model && weight !== null`: loads all eligible open matches, blends, sorts (blended, overall, job id), pages in code.
- `GET /api/matches` → `{ ...MatchListResult, model: ModelSummary }`. `GET /api/matches/[jobId]` → adds `model` and `match.personal`.

**What the patches do:** serializer tests (personal carried for eligible, dropped for ineligible; `factorVectorOf`). Route tests (existing users; `loadEnv` mocks gain `OUTCOME_UNDECIDED_DAYS: 30, OUTCOME_MODEL_MIN_DECIDED: 30, OUTCOME_MODEL_MIN_PER_CLASS: 8`): summary + default ranking + null personal without history; with `insertModelHistory` and two matches (overall 80/skills 0.1 vs overall 75/skills 0.95) the default order stays by score while the strong-skills job has the higher probability and a range containing it; `rank=personal` puts the strong-skills job first with `ranking: "personal"`, `total` 2; the ineligible list is never re-sorted; `rank=bogus` → 400; detail route shows `model` and a `personal` prediction with `raises` containing "Skills" once active.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-6-tests.patch`
- [ ] **Step 2: Run to see it fail** — `pnpm --filter web test -- src/lib/matching src/app/api/matches` → FAIL (8 failing tests: no `personal`, `model`, `ranking`, `factorVectorOf`; `rank=bogus` accepted).
- [ ] **Step 3: Apply the implementation patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-6-impl.patch`
- [ ] **Step 4: Verify** — `pnpm --filter web test -- src/lib/matching src/app/api/matches && pnpm --filter web typecheck && pnpm --filter web lint` → 28 pass, clean (the one pre-existing lint warning is gone since the Phase 10a housekeeping; expect 0 warnings).
- [ ] **Step 5: Commit** — `git commit -m "feat(web): personal response predictions and opt-in personal ranking in the matches API (Phase 10b)"`

---

### Task 7: The response model on `GET /api/insights`

**Files:**
- Modify: `apps/web/src/app/api/insights/route.ts`, `apps/web/src/lib/insights/responseModel.ts`
- Test: `apps/web/src/app/api/insights/route.test.ts`

**Interfaces — Produces:** `ModelInsightsView extends ModelSummary { looLogLoss; baselineLogLoss; factors: FactorEffect[] }` (factors empty unless active) and `toModelInsightsView(loaded)`; the route returns `{ settings, ...insights, model: ModelInsightsView }`, training on the same records it already built (via `trainResponseModelSafely`).

**What the patches do:** the route test's env mock gains the two gate settings; a new test asserts the exact empty model view, then (after `insertModelHistory`) `active` with counts, `looLogLoss < baselineLogLoss`, and `factors[0]` = Skills / higher with odds ratio > 1.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-7-tests.patch`
- [ ] **Step 2: Run to see it fail** — `pnpm --filter web test -- src/app/api/insights` → FAIL (1 test: `body.model` undefined).
- [ ] **Step 3: Apply the implementation patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-7-impl.patch`
- [ ] **Step 4: Verify** — `pnpm --filter web test -- src/app/api/insights src/lib/insights && pnpm --filter web typecheck && pnpm --filter web lint` → 7 pass, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): explain the personal response model on GET /api/insights (Phase 10b)"`

---

### Task 8: UI — toggle, per-match lines, model section

**Files:**
- Create: `apps/web/src/lib/insights/formatPersonal.ts`, `rankPreference.ts` (+ a `.test.ts` for each)
- Modify: `apps/web/src/app/matches/MatchesClient.tsx`, `MatchRow.tsx`, `apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx`, `apps/web/src/app/insights/InsightsClient.tsx`
- Test: `MatchesClient.test.tsx`, `MatchDetailClient.test.tsx`, `InsightsClient.test.tsx`

**Interfaces — Produces:** `formatLikelyResponse(p)`, `formatFactorPushes(p)`, `modelUnavailableReason(model)`; `RANK_PREFERENCE_KEY`, `readRankPreference`, `writeRankPreference`, `subscribeRankPreference`, `serverRankPreference`, `resetRankPreferenceForTests`; `InsightsResponse.model: ModelInsightsView`.

**What the patches do:**
- `MatchesClient`: "Rank with my history" checkbox (disabled with the reason unless the model is active), stored via the `useSyncExternalStore` preference store (no setState-in-effect; server snapshot false), `&rank=personal` on the eligible list request, "Ranked with your history (weight N%)" when the server says `ranking: "personal"`, and **latest-request-wins** (`useRef` counter) so a slower older response can never overwrite a newer one — this race was found by the draft's browser E2E (after a reload both the default and the personal request run; the default answered last and replaced the personal list) and is pinned by a component test that holds the default response back and releases it after the personal one.
- `MatchRow`: "Your history: likely response …" when `match.personal`.
- `MatchDetailClient`: a "Your history" region with the line, "Raises … · Lowers …" and the fixed not-a-cause note.
- `InsightsClient`: a "Your response model" section before the breakdowns — progress to the gate, the yes/no honesty line with both errors, the blend weight, factor lines (`Skills: a higher score has gone with more responses (odds ×3.4 per typical step).` / `÷` for "lower"), factors with odds ratio < 1.1 grouped as `Little or no link so far: Role, Experience.`, and the not-a-cause note.

- [ ] **Step 1: Apply the test patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-8-tests.patch`
- [ ] **Step 2: Run to see it fail** — `pnpm --filter web test -- src/lib/insights src/app/matches src/app/insights` → FAIL (missing `./formatPersonal` / `./rankPreference`, no toggle, no history section, no model section).
- [ ] **Step 3: Apply the implementation patch** — `git apply --index docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/task-8-impl.patch`
- [ ] **Step 4: Verify** — `pnpm --filter web test -- src/lib/insights src/app/matches src/app/insights && pnpm --filter web build && pnpm --filter web typecheck && pnpm --filter web lint` → 125 pass, build lists `/matches` and `/insights`, clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): Rank with my history toggle, per-match likely response and the model section on Insights (Phase 10b)"`

---

### Task 9: Documentation

**Files:** Modify `DECISIONS.md`, `FLOW.md`, `docs/architecture.md`, `README.md`, the spec.

- [ ] **Step 1: DECISIONS.md** — insert D146–D151 immediately before the closing italic footer line (`*Entries are appended chronologically…*`), each with **Decision / Why / Alternatives considered / What it affects**, describing only what Tasks 1–8 built:
  - **D146. Phase 10b personal response model: target, features, gate, fit on read.** Response tier only; the 9 factor scores as the only features (known at apply time via the snapshot and for unapplied jobs via `job_matches`; documents sent are not); training rows = decided, non-external, eligible match; gate 30 decided with ≥ 8 per class (env); trained on every request from 10a's dataset, no tables (same reasoning as D140; ~40 ms per request including the leave-one-out check at 40 rows, measured in the draft). Alternatives: interview tier (too rare), re-learning the factor weights (changes every score's meaning; unstable at small n), storing the model at matching time (stale exactly when outcomes are recorded).
  - **D147. Deterministic ridge logistic regression with a Laplace range.** Standardization, null → mean, constant factors dropped, λ = 1 on standardized coefficients (intercept unpenalized), Newton from zeros (≤ 50 iterations, step < 1e-8), inverse penalized Hessian as the covariance, `σ(logit ± 1.96√(xᵀΣx))` range; verified against an independent NumPy computation to 8 decimals. Alternatives: gradient descent (iteration-count sensitive, not bit-reproducible across tuning), bootstrap ranges (random), an ML library dependency (unnecessary for ≤ 10 parameters).
  - **D148. Honesty gates and failure isolation.** `insufficient_data` → leave-one-out log-loss must strictly beat the base rate → `active`; a failing fold predicts the baseline; any training/load error is logged by class name only and becomes `no_pattern` with default ranking. Evaluation fixtures (planted single/double/negative signal, noise, tiny sample, consistency) run as tests. Alternatives: in-sample fit statistics (always look good on small data), a p-value threshold (harder to explain).
  - **D149. Opt-in blended ranking.** `w = min(0.5, decided/200)`, blended score, sort blended → overall → job id, eligible list only, paged in code; the response states `ranking`; the toggle is a browser-only preference (`useSyncExternalStore`, key `careerpilot.rankWithHistory`, in-memory fallback); only the latest list request may update the page (a race the draft E2E found after reload). Alternatives: server-stored preference (no user model for preferences; single user), always-on ranking (spec: opt-in), replacing the score (spec §2 decision 1).
  - **D150. `@ai-career/matching/scoring` subpath.** Pure scoring functions, factor types and `FACTOR_KEYS` without the pipeline; a static import-graph test keeps it free of external imports; `packages/insights` uses only this (closes the Phase 10a deferred Minor about pulling the Anthropic SDK). Alternatives: duplicating `scoreRole`/factor keys in insights (drift), a separate package (overhead for 10 files).
  - **D151. Wording of predictions and factors.** "likely response X% (low–high%)" always with the range; raises/lowers beyond ±0.1 logit, ≤ 2 per side; factor strength as odds per typical step with ×/÷; factors under 1.1× odds grouped as "Little or no link so far" (no direction claimed — added after the draft E2E showed "÷1.0" lines); fixed not-a-cause notes; never "because/causes/predicts you will".
- [ ] **Step 2: FLOW.md** — append `## 15. Phase 10b — Personal Response Model` with: §15a `GET /api/matches` (`loadResponseModel` → `loadInsightInputs` → `buildOutcomeDataset` → `trainResponseModelSafely` → `trainResponseModel` [`trainingRows` → `fitModel` (`fitScaling`, `standardize`, `fitLogistic`) → leave-one-out → status] → `listMatches(tx, query, { model, weight })` → `predictResponse` per eligible row → default SQL order, or with `rank=personal` + active model: all eligible rows → `blendedScore` → sort → page); §15b `GET /api/matches/[jobId]` (same loader, one prediction); §15c `GET /api/insights` (same records → `trainResponseModelSafely` → `toModelInsightsView`); §15d the client (`useSyncExternalStore` preference → request with `&rank=personal` → latest-request-wins); "Changing Phase 10b behavior" bullets (gate settings in env; λ/thresholds as named constants in `src/model/*`; labels in `FACTOR_LABELS`).
- [ ] **Step 3: docs/architecture.md** — add `## 20. Personal Response Model (Phase 10b)` after §19: what it is, how (fit on read, D146–D149), honesty rules, the scoring subpath (D150), known gaps (feedback loop from personal ranking; factor drift if scoring changes; correlated factors split credit; leave-one-out cost grows with history — cache by a hash of the training rows if it ever matters; interview-tier model not built).
- [ ] **Step 4: README.md** — append to `## Status`: Phase 10b paragraph — the model learns from your own decided applications which match factors have gone with responses; shows "likely response" with a range on matches once there are ≥ 30 decided applications (≥ 8 with and without a response; env-configurable) and the model beats your average; an opt-in "Rank with my history" toggle blends it into the ranking (up to 50%); explained on `/insights`; no AI calls.
- [ ] **Step 5: Spec** — set `Status:` to implemented (fill in on merge) and append `## 12. Post-implementation notes`: weak factors (< 1.1× odds) grouped as "Little or no link so far"; latest-request-wins in `MatchesClient`; the preference store uses `useSyncExternalStore` with an in-memory fallback; `GET /api/insights`'s `model.factors` is always present (empty unless active); the web helper is `apps/web/src/lib/insights/responseModel.ts` (exporting `loadResponseModel`, `trainResponseModelSafely`, `toModelInsightsView`) rather than §5's `loadResponseModel.ts`; the Insights factor lines read `Skills: a higher score has gone with more responses (odds ×1.4 per typical step).` (and `fewer` / `÷` for a negative direction) instead of §6's example sentence; decisions D146–D152.
- [ ] **Step 6: Check cited paths exist** — `for p in packages/matching/src/scoring/index.ts packages/insights/src/model/fitLogistic.ts packages/insights/src/model/trainResponseModel.ts packages/insights/src/model/predictResponse.ts packages/insights/src/model/prepareFeatures.ts apps/web/src/lib/insights/responseModel.ts apps/web/src/lib/insights/rankPreference.ts apps/web/src/lib/insights/formatPersonal.ts apps/web/src/lib/matching/listMatches.ts; do test -f "$p" || echo "MISSING $p"; done` → no output.
- [ ] **Step 7: Commit** — `git commit -am "docs: Phase 10b decisions D146-D151, FLOW §15, architecture §20, README"`

---

### Task 10: Verification and real-browser E2E

**Files:** Modify `DECISIONS.md` (D152). Scratch only (never committed): server log, screenshot, Playwright install.

- [ ] **Step 1: CI-order checks** — from the repo root: `pnpm install --frozen-lockfile && pnpm --filter @ai-career/db db:migrate && pnpm lint && pnpm build && pnpm typecheck && pnpm run test --force`, then `pnpm run test --force` once more. Expected: all exit 0; lint 0 errors and 0 warnings; 17/17 packages both runs (≈ 1829 tests).
- [ ] **Step 2: Seed** — from `apps/web`: `../../services/browser-worker/node_modules/.bin/tsx ../../docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/e2e/seed.mts` → prints `{"seeded":"00000000-0000-0000-0000-000000000a08",…}`.
- [ ] **Step 3: Start the built app as that user on the test DB** (background; port 3031):
  `DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test DEFAULT_USER_ID=00000000-0000-0000-0000-000000000a08 PORT=3031 pnpm --filter web start` — wait for `GET http://localhost:3031/api/health` → 200.
- [ ] **Step 4: Browser checks** — in a scratch directory: `npm init -y && npm install playwright-core`, copy `docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/e2e/e2e.mjs` there, run `BASE_URL=http://localhost:3031 node e2e.mjs <scratch>/insights-10b.png`. Expected: 11 `"ok":true` checks and `{"passed":11}`, exit 0 (default order by score; both likely-response lines; toggle enabled; personal order + weight 20% note; survives reload; detail explanation; insights model text; turning off restores the order and stores `"0"`). Any failure is a bug to fix test-first, never a script to loosen.
- [ ] **Step 5: Clean up** — stop the server (`kill $(lsof -ti :3031)`, confirm nothing listens), run the seed script with `wipe` (prints `{"wiped":…}`), and confirm `SELECT count(*)` of `applications`, `jobs`, `career_goals` for user `…000000000a08` in `career_intel_test` are all 0.
- [ ] **Step 6: D152** — append before the DECISIONS.md footer: `### D152. Phase 10b verification: CI-order checks and a real-browser E2E on a synthetic user` with the commands run, the test counts observed, the 11 checks and their observed values (e.g. likely responses and the personal order), the cleanup counts; "What it affects: No source changes."
- [ ] **Step 7: Commit** — `git commit -am "docs: D152 Phase 10b verification"`
