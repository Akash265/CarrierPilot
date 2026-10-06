# Phase 10b — Personal Response Model: Design

Date: 2026-10-06
Status: Approved in brainstorming (ranking approach, target, data gate, compute-on-read, sections 1–2) on 2026-10-06. Awaiting review as a written spec (section 3 below — errors, testing, evaluation, risks — is first presented here).
Spec sources: project spec §1, §8 ("initial ranking factors ... allowing future learning"), §14 ("train a simple personal model such as logistic regression ... show confidence and sample size rather than pretending"), §16, §21 (Phase 10 — interpretable baseline model, personal ranking adjustments), §24 criterion 15. Builds on Phase 10a (`docs/superpowers/specs/2026-10-06-phase-10a-outcome-analytics-design.md`, D140–D145).

## 1. Scope

In scope:
- An interpretable personal model in `packages/insights`: ridge-regularized logistic regression predicting **"got a response"** (10a's response tier) from the **9 match factor scores**.
- Honesty gates: a minimum-data gate and a "beats your average" leave-one-out check.
- Per-match predictions with a 95% range and the factors that push them up/down.
- An **opt-in** "Rank with my history" toggle on `/matches` that re-sorts the eligible list by a blend of the match score and the prediction.
- A "Your response model" section on `/insights`.
- A `@ai-career/matching/scoring` subpath export so `packages/insights` stops importing matching's root (the Phase 10a deferred Minor: the root pulls the Anthropic SDK and `@ai-career/ai`).

Out of scope:
- An interview-tier model (rare positives; added later once it could pass its own gate).
- Changing stored match scores, factor weights, eligibility, matching runs or the worker.
- New tables or migrations. Any LLM call.
- Server-side persistence of the toggle (browser-only preference).

## 2. Decisions taken in brainstorming

1. **Show it, opt in to rank with it.** The default ranking is unchanged; predictions are shown when the model is active; a toggle re-sorts by a blend.
2. **Target = "got a response".** Responses are 2–4× more common than interviews, so the model becomes usable sooner. Wording is always "likely response", never "interview".
3. **Gate = 30 decided, ≥ 8 responses, ≥ 8 non-responses** (env-configurable).
4. **Fit on read, no tables** (same reasoning as D140): fitting ≤ hundreds of rows × 9 features takes milliseconds and is never stale — recording an outcome changes predictions on the next load.
5. **Features = the 9 factor scores only**, because they are the only signals known both at apply time (snapshot) and for jobs not yet applied to (current `job_matches`). Documents sent cannot be known before applying.

## 3. Training data

From 10a's `buildOutcomeDataset` records. A record is a training row when all hold:
- `external` is false;
- its `response` label is `positive` (y = 1) or `negative` (y = 0);
- its snapshot has a match block with `eligible === true` (ineligible matches carry no factor scores).

`parseSnapshot` / `OutcomeRecord` gain `factors: FactorVector | null`, where `FactorVector` has the 9 keys of matching's `FactorScores` (`skillsScore`, `experienceScore`, `locationScore`, `sponsorshipScore`, `roleScore`, `salaryScore`, `industryScore`, `freshnessScore`, `semanticScore`), each `number | null` (0–1). `factors` is null when there is no eligible match block. v1 and v2 snapshots both already store these (`snapshot.match.*Score`); no write-path change.

## 4. The model — `packages/insights/src/model/`

### 4.1 Preparation (`prepareFeatures`)
- For each factor: training mean and population standard deviation over training rows with a non-null value.
- A factor with fewer than 2 non-null values or standard deviation < 1e-9 is **dropped** (it cannot teach anything).
- A null value (at fit or at prediction) is replaced by that factor's training mean, i.e. a standardized value of 0.
- Standardized value `z = (x − mean) / sd`.

### 4.2 Fit (`fitLogistic`)
- Logistic regression with intercept; L2 penalty `λ = 1` on the standardized coefficients, **not** on the intercept.
- Newton–Raphson from all-zero coefficients; stop when the max absolute step < 1e-8 or after 50 iterations. Deterministic: same input → bit-identical output.
- Returns intercept, coefficients and the inverse of the penalized Hessian at the optimum (the covariance used in §4.5).
- If the Hessian is not invertible (cannot happen with λ > 0 on dropped-constant features, but guarded): status `no_pattern`.

### 4.3 Gates (`trainResponseModel`)
Evaluated in order; the first that fails sets the status:
1. **`insufficient_data`** — fewer than `OUTCOME_MODEL_MIN_DECIDED` (default 30) training rows, or fewer than `OUTCOME_MODEL_MIN_PER_CLASS` (default 8) of either class, or no factor left after dropping.
2. **`no_pattern`** — leave-one-out check: for each training row, refit without it and compute its log-loss; also compute the baseline log-loss of predicting the mean response rate of the other rows. Probabilities are clamped to [1e-6, 1 − 1e-6]. The model passes only if its mean LOO log-loss is **strictly lower** than the baseline's.
3. **`active`** — otherwise; the final model is the fit on all training rows.

`trainResponseModel` always returns: `status`, `decided` (training rows), `responses`, `nonResponses`, the gate settings, `looLogLoss` and `baselineLogLoss` (null when `insufficient_data`), and — when `active` — the model (means, sds, kept factors, intercept, coefficients, covariance) and `blendWeight`.

### 4.4 Blend weight
`w = min(0.5, decided / 200)` — 0.15 at 30, 0.5 at ≥ 100. Defined only when `active`.

### 4.5 Prediction (`predictResponse`)
Input: the active model and a match's current factor scores (`number | null` each). Output:
- `probability = σ(b0 + Σ βj zj)`.
- `low`, `high`: 95% range from the Laplace approximation — logit variance `v = xᵀ Σ x` with x = (1, z…) and Σ the covariance from §4.2; `σ(logit ± 1.96 √v)`.
- `raises` / `lowers`: the factors with contribution `βj zj` > 0.1 / < −0.1 (logit units), up to 2 each, largest magnitude first, by display label: Skills, Experience, Location, Sponsorship, Role, Salary, Industry, Freshness, Fit (`semanticScore` → "Fit", matching `/matches`' existing chips).

### 4.6 Ranking
- `blendedScore = (1 − w) × overallScore + w × 100 × probability`, rounded to one decimal.
- Personal order: blended score desc, then overall score desc, then job id. Only the eligible list is re-sorted; the ineligible list is unchanged.

## 5. API

All changes are additive; existing fields keep their shape.

A shared server helper `apps/web/src/lib/insights/loadResponseModel.ts` runs `loadInsightInputs` → `buildOutcomeDataset` → `trainResponseModel` with the env settings, and returns the model result plus a `ModelSummary` view: `{ status, decided, responses, nonResponses, minDecided, minPerClass, blendWeight | null }`.

- **`GET /api/matches`** — adds `model: ModelSummary` and `ranking: "default" | "personal"`, and each `MatchListItem.match` gains `personal: { probability, low, high, raises, lowers } | null` (null unless the model is active and the match is eligible). New query parameter `rank=default|personal` (default `default`). With `rank=personal`, `eligible=true` **and** an active model, the route loads every eligible open match, predicts, blends, sorts (§4.6) and pages in code (same `PAGE_SIZE` 25 and `total`); otherwise the existing SQL order is used and `ranking` is `"default"`. `rank` is validated by the existing query schema (unknown value → 400).
- **`GET /api/matches/[jobId]`** — adds `model: ModelSummary` and `personal` on the match (same rule).
- **`GET /api/insights`** — adds `model`: the `ModelSummary` plus `looLogLoss`, `baselineLogLoss`, and when active `factors: [{ key, label, direction: "higher" | "lower", oddsRatio }]` for kept factors sorted by |β| desc, where `oddsRatio = e^{|β|}` per one standard step of that factor.

Errors: unchanged (unexpected errors → 500). The model can never make a matches request fail: any thrown error inside model training is caught in `loadResponseModel`, logged by class name only, and reported as status `no_pattern` with ranking `"default"`.

## 6. UI

- **`/matches`** — a checkbox "Rank with my history". Disabled unless `model.status === "active"`, with the reason beside it:
  - `insufficient_data`: "Needs {minDecided} decided applications with at least {minPerClass} responses and {minPerClass} without. You have {decided} ({responses} with a response)."
  - `no_pattern`: "Your history doesn't show a pattern that beats your average yet."
  The choice is remembered in `localStorage` (key `careerpilot.rankWithHistory`, wrapped in try/catch) and sent as `rank=personal`. When the response says `ranking: "personal"`, a note reads "Ranked with your history (weight {round(w×100)}%)".
- **Each match row** (model active): "Your history: likely response 35% (22–50%)".
- **`/matches/[jobId]`** (model active): the same line plus "Raises: Skills, Role · Lowers: Freshness" (omitted parts when empty), and the fixed note "Based on how these factors have gone with responses in your own applications — not a cause or a guarantee."
- **`/insights`** — a "Your response model" section before the breakdowns: status and progress to the gate; when evaluated, "Predicts responses better than your average: yes/no" with the two log-losses; when active, the factor list ("Higher skills match has gone with more responses (×1.4 per typical step)").

Wording rules (as 10a): never "because", "causes", "predicts you will"; always "likely", with the range and the sample size.

## 7. Package boundary

`packages/matching/package.json` gains the export `"./scoring": "./src/scoring/index.ts"`, a new barrel exporting the scoring functions and `FactorScores`/`FACTOR_WEIGHTS` types/constants with no imports outside `src/scoring` and `src/types.ts`. `packages/insights` imports only from `@ai-career/matching/scoring`. A test asserts the subpath module graph contains no `@anthropic-ai/sdk` or `@ai-career/ai` import (a static scan of the files reachable from `src/scoring/index.ts`).

## 8. Config

`packages/config/src/env.ts` and `.env.example`:
- `OUTCOME_MODEL_MIN_DECIDED`: integer ≥ 10, default 30.
- `OUTCOME_MODEL_MIN_PER_CLASS`: integer ≥ 3, default 8.

## 9. Testing and evaluation

- **Unit — fit:** `fitLogistic` against reference coefficients for a fixed small dataset (computed independently with NumPy Newton iterations, values recorded in the test); determinism (two fits bit-identical); λ shrinks coefficients toward 0 versus λ = 1e-6; separable data stays finite (ridge).
- **Unit — preparation:** means/sds, dropped constant factors, null → mean imputation.
- **Unit — gates:** each `insufficient_data` cause; a dataset where labels are a deterministic function of skills → `active` with skills the top factor; shuffled/random labels with no signal → `no_pattern`; LOO numbers reported.
- **Unit — prediction:** probability, range containing the probability and inside [0, 1], range narrowing as data grows, raises/lowers thresholds and caps, label mapping.
- **Unit — blend/ranking:** weight formula at 30/100/500; tie-breaks.
- **Evaluation dataset (CLAUDE.md §10 "AI evaluation"):** a fixture of synthetic histories (signal in one factor, signal in two factors, pure noise, tiny sample) with expected status and top factors, run as a test — the model's behaviour is checked for both accuracy (finds the planted factor) and consistency (identical across runs).
- **Integration:** `loadResponseModel` on the test DB (seeded ingested applications with snapshots + events); `GET /api/matches` with and without `rank=personal` (order changes only when active; `total`, paging, ineligible list unchanged; `rank=bogus` → 400); `GET /api/matches/[jobId]` and `GET /api/insights` additions; a thrown training error degrades to default ranking.
- **Package boundary:** the subpath static-scan test (§7).
- **UI:** `MatchesClient` toggle (disabled reasons, localStorage, request parameter, ranked note), `MatchRow`/detail lines, Insights model section.
- **Verification:** CI-order full run; real-browser E2E on a synthetic user with ≥ 30 seeded decided applications whose responses follow the skills factor: model active, toggle re-sorts, predictions and the Insights section render; cleanup.
- New test user ids are checked against the whole repository before use.

## 10. Documentation

DECISIONS.md from D146 (model/target/gates, blend, fit-on-read, subpath export, verification); FLOW.md §15; docs/architecture.md §20; README; spec post-implementation notes.

## 11. Risks

- **Small, biased data.** Gates and the LOO check keep the model off until it demonstrably beats the average; the blend weight stays ≤ 0.5.
- **Feedback loop.** Ranking with the model influences which jobs get applied to, which becomes future training data. Mitigated by opt-in, the weight cap, and the default ranking staying the deterministic score.
- **Factor drift.** Snapshot factors were computed by the matching code at apply time; if scoring logic changes later, old and new factor values are not strictly comparable. Documented; a future snapshot field could record a scorer version.
- **Correlated factors.** Ridge keeps coefficients stable but splits credit between correlated factors; the UI shows directions and rough strength, not precise effects.
- **Performance.** Fit + LOO is O(n) Newton fits per request; at n ≤ 500 this is tens of milliseconds. If histories grow far beyond that, LOO can be cached by a hash of the training rows (not built now).
