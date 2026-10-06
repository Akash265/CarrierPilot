# Phase 10a — Outcome Analytics: Design

Date: 2026-10-06
Status: Approved in brainstorming (scope split, outcome tiers, role family, approach, sections 1–3) on 2026-10-06. Awaiting review as a written spec.
Spec sources: project spec §1 (learning from outcomes), §14 (Application Tracker & Feedback Loop: outcome-learning fields, interpretable model, confidence and sample size), §16 (Rejection & Re-optimization Loop), §19 (`application_outcomes`, `learning_features`), §21 (Phase 10 — Feedback & Learning), §24 success criteria 14–15.

## 1. Scope

Phase 10 is split in two (decided in brainstorming):

- **10a — Outcome analytics (this spec).** Turn each application's write-once feature snapshot plus its outcome history into an outcome dataset, and show an Insights page: response and interview rates overall and broken down by role family, company, work mode, match-score band, keyword-coverage band, posting age, documents sent, and more — every number with its sample size and a confidence interval — plus the §16 rejection-pattern view.
- **10b — Learned layer (later, separate spec).** An interpretable baseline model (logistic regression at most) and an opt-in personal ranking adjustment fed back into matching, gated on a minimum number of decided applications. 10b builds on 10a's dataset.

In scope for 10a:
- A new pure domain package `packages/insights`.
- Feature snapshot v2: `missedRequiredTerms` recorded at apply time (`packages/applications`).
- `GET /api/insights` and an `/insights` page; links from the home page and `/applications`.
- Two env settings: `OUTCOME_UNDECIDED_DAYS`, `INSIGHTS_MIN_BUCKET`.

Out of scope for 10a:
- Any prediction, model, or score, and any change to matching or ranking (10b).
- Any LLM call. The whole Insights computation is deterministic.
- New tables. `application_outcomes` and `learning_features` (spec §19) are not built; see §2 decision 4.
- Notifications, exports, charts beyond simple bars in tables.

## 2. Decisions taken in brainstorming

1. **Split into 10a/10b** (above). 10a is useful from around the tenth application; 10b needs 10a's dataset first.
2. **Two outcome tiers, both shown.** "Got a response" and "Got an interview" (§4). The response tier has more positives, so it gives usable statistics sooner; the interview tier is the spec's target.
3. **Role family = the user's own career-goal target roles**, assigned deterministically (§4.3). No LLM, no fixed taxonomy.
4. **Compute on read, no new tables.** A pure package builds the dataset and statistics on each request. At a single user's scale (tens to hundreds of applications) this is milliseconds and can never go stale. The existing `applications.feature_snapshot` already *is* the historical feature snapshot spec §19's `learning_features` describes, and Phase 9 (D117) already chose to derive outcomes rather than store an `application_outcomes` table. The deviation is logged in DECISIONS.md; 10b may add persistence if a model needs stored, versioned feature vectors.
5. **Honest statistics.** Wilson 95% intervals, a minimum bucket size below which no rate is shown, "stands out" only when the interval clears the overall rate, non-causal wording, and an explicit chance caveat (§5).

## 3. Inputs

All read in one `withUserContext` transaction under `repeatable read`, so the four reads are one consistent view:

| Input | Fields used |
|---|---|
| `applications` | `id`, `job_id`, `company_name`, `job_title`, `status`, `applied_at`, `created_at`, `feature_snapshot` |
| `application_events` | `application_id`, `type`, `occurred_at`, `to_status` (types `status_change`, `recruiter_contact`, `interview` only) |
| `career_goals` | `id`, `confirmed_at` (confirmed goals only) |
| `career_goal_constraints` | `career_goal_id`, `target_roles`, `salary_floor_normalized`, `salary_currency`, `salary_is_parsed` |

Never read: `notes`, `recruiter_name`, `recruiter_contact`, `salary_notes`, event `detail` (§8).

`now` is passed in (route uses `new Date()`), so every rule is testable at fixed times.

## 4. The outcome dataset — `buildOutcomeDataset`

Pure: `(inputs, { now, undecidedDays }) → OutcomeRecord[]`, one record per application.

### 4.1 Stages and evidence

Statuses are ordered into stages: `applied` < `screening` < `interviewing` < `offer` < `accepted` = `declined` (`declined` sits after `accepted` in the tracker: the user declined an offer). `rejected`, `withdrawn` and `no_response` are endings, not stages.

The **highest stage reached** is the maximum over the current status and every `status_change` event's `to_status` — history, not just the current status. An application that went screening → rejected did get a response.

- **Response evidence:** highest stage ≥ `screening`, or any `recruiter_contact` or `interview` event.
- **Interview evidence:** highest stage ≥ `interviewing`, or any `interview` event.

So `accepted`/`declined` (they imply an offer) are positive for both tiers, even if reached directly from `applied` under the permissive lifecycle.

### 4.2 Labels

Each tier gets `positive`, `negative`, `undecided` or `excluded`:

1. Evidence for the tier → **positive** (always wins, including for withdrawn applications).
2. Otherwise, status `withdrawn` → **excluded** (the user stopped, not the employer; it is neither a success nor a failure).
3. Otherwise, a terminal status (`rejected`, `no_response`) → **negative**.
4. Otherwise (open: `applied`, `screening`, `interviewing`, `offer`), if the last activity is at least `undecidedDays` days before `now` → **negative** ("no response in N days" / "no interview in N days").
5. Otherwise → **undecided**.

`offer` without an interview event and without an `interviewing` stage still has interview evidence (offer ≥ interviewing), so rule 4 never applies to it for the interview tier.

**Last activity** = the latest of `applied_at` (as midnight UTC), every `status_change` `occurred_at`, and every `recruiter_contact`/`interview` `occurred_at`. Notes and follow-up events are the user's own actions and do not count. A future-dated `interview` event (interviews may be logged ahead) counts as evidence and as activity.

Each label carries a short **reason** for the UI, e.g. `"Interview: reached interviewing on 2026-10-12"`, `"No response: no activity for 30 days"`, `"Excluded: withdrawn"`.

`undecidedDays` = `OUTCOME_UNDECIDED_DAYS` (default 30, integer ≥ 1).

### 4.3 Role family

1. **Goal for the application:** `feature_snapshot.match.careerGoalId` if present and that goal's constraints exist; otherwise the confirmed goal with the latest `confirmed_at` ≤ the application's `created_at`; otherwise none.
2. Score each of that goal's `target_roles` separately: `scoreRole([role], jobTitle)` from `@ai-career/matching`. The highest score wins if ≥ 0.5; ties go to the first role in the goal's list. Below 0.5, or no goal, or no target roles → `"Other"`.

The family label is the target role's text as the user wrote it. The same role written in two goal versions with different casing/spacing is merged by a trimmed, case-insensitive key; the display text is the most recent goal's spelling.

### 4.4 Record fields

`OutcomeRecord`: `applicationId`, `external`, `appliedAt`, `response` / `interview` (`{ label, reason }`), `roleFamily`, and the dimensions below. Any value the snapshot does not have is `null` ("unknown"), never zero.

| Dimension | Source | Buckets |
|---|---|---|
| Company | `applications.company_name` | Company name (trimmed, case-insensitive key) |
| Work mode | snapshot `job.workMode` | remote / hybrid / onsite / unknown |
| Country | snapshot `job.countryCode` | Code, or unknown |
| Salary vs floor | snapshot `job.salaryMin`/`salaryMax`/`salaryCurrency` vs the goal's floor (§4.3 goal) | below floor / at or above floor / unknown (no salary, no parsed floor, or currency differs) — "below" when `salaryMax` (or `salaryMin` if no max) is below the floor |
| Match score | snapshot `match.overallScore` (0–100), only when `match.eligible` | <50, 50–69, 70–84, 85+ |
| ATS score | snapshot `ats.overallScore` (0–100) | <50, 50–69, 70–84, 85+ |
| Required keyword coverage | snapshot `ats.requiredKeywordCoverage` (0–1) | <50%, 50–79%, 80%+ |
| Posting age at apply | snapshot `job.postingAgeDays` | 0–2, 3–7, 8–30, 30+ days |
| Optimized resume sent | snapshot `documents.resume` | yes / no |
| Pitch sent | snapshot `documents.pitch` | yes / no |
| Cover letter sent | snapshot `documents.coverLetter` | yes / no |
| Edited by you | any of pitch/cover letter with `origin = "user_edited"` | yes / no |
| Missed required terms | snapshot v2 `ats.missedRequiredTerms` | (used by §5.4 only) |

External applications (`external: true`) have only role family and company; every other dimension is unknown for them. Documents-sent dimensions for external applications are unknown, not "no".

## 5. Statistics — `computeInsights`

Pure: `(records, { minBucket }) → Insights`. `minBucket` = `INSIGHTS_MIN_BUCKET` (default 5, integer ≥ 2).

### 5.1 Wilson interval

95% Wilson score interval (z = 1.96) for `positives / decided`, where decided = positive + negative. Returned as `{ low, high }` in [0, 1]. Defined for decided ≥ 1.

### 5.2 Headlines (per tier)

`{ decided, positives, negatives, undecided, excluded, rate, interval }`. `rate` and `interval` are `null` when decided < `minBucket`; counts are always shown.

### 5.3 Breakdowns (per tier, per dimension)

For each dimension: an ordered list of buckets `{ key, label, decided, positives, rate, interval, standsOut }` plus `unknownCount` (records with no value for this dimension, any label). Unknown records are not a bucket; the UI shows "N applications have no data for this".

- Below `minBucket` decided: `rate`, `interval` and `standsOut` are `null` ("not enough data").
- `standsOut`: `"higher"` if the bucket's interval low is above the tier's overall rate; `"lower"` if its interval high is below it; else `null`. Only when both the bucket and the headline have rates.
- Ordering: fixed band order for banded dimensions; by decided count (desc) then label for role family, company and country. Company and country show at most 15 buckets; the rest are summed into one "Others" bucket that is never flagged.

### 5.4 Rejection patterns (spec §16)

Computed on the **interview** tier when its headline has a rate, else the response tier; the payload says which tier was used.

- **Recurring missed requirements.** Over records with snapshot v2 `missedRequiredTerms` (non-null): for each term (trimmed, case-insensitive key), count negatives that missed it and positives that missed it. List terms missed in ≥ 2 negatives, sorted by negative count desc, then term, max 20: `{ term, missedInNegatives, missedInPositives, negativesWithData, positivesWithData }`.
- **High coverage, poor results.** Records with required coverage ≥ 0.8: `{ decided, positives, rate, interval }`, compared to the tier's overall rate with the same `standsOut` rule. Shown only when decided ≥ `minBucket`.

Weak role families need no separate view: they appear as `standsOut: "lower"` in the role-family breakdown.

### 5.5 Wording rules (UI)

- Rates as whole percentages with counts: "22% (11 of 50)". Interval in words: "likely between 13% and 35%".
- Flags: "higher/lower than your overall rate (n=12)". Never "because", "causes", or "predicts".
- A fixed caveat under the breakdowns: with many comparisons some differences appear by chance; flags mark things worth a look, not conclusions.

## 6. Snapshot v2 — `packages/applications`

`buildFeatureSnapshot` writes `snapshotVersion: 2`. The only change is a new field on `ats`: `missedRequiredTerms: string[] | null`.

- In `createApplication`, when a resume optimization is linked: load the job's `job_requirements` with `requirement_level = 'required'` and the optimization's `selected_bullets`, join the bullets' `optimizedText` with `"\n"` (the same text `runResumeOptimization` scores), and record each required term (non-blank) not contained in it, case-insensitive substring — the `scoreKeywordCoverage` rule. Order: the requirements' stored order (`created_at`, `id`), de-duplicated by case-insensitive key.
- No linked optimization → `ats` is `null` as today, so missed terms are unknown. An optimization always has its evaluation (`runResumeOptimization` inserts both in one transaction), so a linked optimization always yields a full `ats` object with `missedRequiredTerms` added.
- The helper `findMissedTerms(terms, text)` lives in `packages/applications` (keeps the package free of the resume-optimization package's Anthropic dependency). A parity test checks it against `scoreKeywordCoverage` on shared cases: `missed.length === round(required × (1 − coverage))`.
- Uses the job's current requirements at apply time. They are re-extracted only when the job description changes, so in practice they are the ones the resume was optimized against.
- `feature_snapshot` stays write-once (D116). v1 snapshots are read as `missedRequiredTerms: null`.
- `packages/insights` reads both versions through one tolerant parser: unknown or malformed fields become `null`, never a thrown error. A malformed snapshot yields a record with only the `applications` columns.

## 7. API and UI

### 7.1 `GET /api/insights`

`apps/web/src/app/api/insights/route.ts`: `loadEnv` → `createDbClient` → `loadInsightInputs` → `buildOutcomeDataset` → `computeInsights` → JSON. 200 with:

```
{
  settings: { undecidedDays, minBucket },
  totals: { applications, external },
  tiers: { response: Headline, interview: Headline },
  breakdowns: { response: Dimension[], interview: Dimension[] },
  patterns: { tier: "interview" | "response", missedTerms: [...], highCoverage: {...} | null }
}
```

No query parameters. Errors: only unexpected ones (500 via Next). An empty dataset is a 200 with zero counts.

### 7.2 `/insights` page

`apps/web/src/app/insights/page.tsx` + `InsightsClient.tsx` (client fetch, same pattern as `/applications`):

- Headline cards for both tiers (§5.5 wording); undecided and excluded counts beneath.
- Empty state while the response tier has fewer than `minBucket` decided: "Insights appear after {minBucket} decided applications. You have {n} ({u} still waiting)." Breakdowns are still listed with counts.
- A tier toggle (Response / Interview) for the breakdown tables.
- One `<details>` table per dimension: bucket, decided, positives, rate with interval, a simple CSS bar, a "Higher"/"Lower" badge; grey "Not enough data" rows; the unknown-count note.
- "Rejection patterns" section (§5.4), with the tier used.
- "How this is calculated": the two tiers, the cutoff, withdrawn exclusion, role-family rule, minimum bucket, chance caveat.
- Nav links: home page and the `/applications` header.

## 8. Privacy and security

- The response carries aggregates, bucket labels, company names, target-role text and requirement term text. Never notes, recruiter fields, salary notes, event details, URLs or application ids.
- Reads only under RLS (`withUserContext`); no writes in 10a except the snapshot field written by the existing `createApplication` transaction.
- No new logging. Errors carry no application content.

## 9. Config

`packages/config/src/env.ts` and `.env.example`:
- `OUTCOME_UNDECIDED_DAYS`: integer ≥ 1, default 30.
- `INSIGHTS_MIN_BUCKET`: integer ≥ 2, default 5.

CI needs no change (both have defaults).

## 10. Testing

- **Unit (`packages/insights`):** stages/evidence and every label path (each status; withdrawn with and without evidence; open at exactly `undecidedDays` − 1 ms and at `undecidedDays`; future-dated interview event; offer without interview event); last-activity rules (notes ignored); role family (best role, tie to first, threshold, no goal, fallback goal by `confirmed_at`, merge across goal versions); bands at every boundary; salary-vs-floor including currency mismatch; Wilson interval against known values (0/n, n/n, 5/10, 1/1); `standsOut` both directions and null cases; company "Others" collapsing; missed-term pattern counting and sorting; tolerant snapshot parsing (v1, v2, external, malformed).
- **Unit (`packages/applications`):** `findMissedTerms` cases and the `scoreKeywordCoverage` parity test.
- **Integration:** `createApplication` writes snapshot v2 with missed terms (seeded requirements + optimization) and `null` without an optimization; `loadInsightInputs` against the test DB; RLS: another user's applications never appear; `GET /api/insights` route test (empty and populated).
- **UI:** `InsightsClient` component test (empty state, headline wording, "Not enough data", badges, unknown note, tier toggle).
- **Verification:** CI-order lint/build/typecheck/full forced test run; a real-browser E2E on the test DB with a synthetic user (seeded applications covering every label path), cleaned up afterwards.
- New test user ids are checked against the whole repository before use (the D45/Task 11/Phase 5 collision lesson).

## 11. Documentation

- DECISIONS.md from D140: compute-on-read and the `learning_features`/`application_outcomes` deviation; label rules and tiers; role family; snapshot v2; statistics and wording; verification.
- FLOW.md §14: request flow for `/insights` and the snapshot v2 write in `createApplication`.
- docs/architecture.md: a Phase 10a section; §17 (applications) notes snapshot v2.
- README: the Insights page.

## 12. Risks

- **Small samples.** Most buckets will say "not enough data" for a long time. That is the intended honest behaviour; the minimum is configurable.
- **Multiple comparisons.** Many buckets × two tiers will produce some chance flags. Mitigated by the interval-clears-overall rule and the caveat; not corrected statistically (no Bonferroni) to keep it explainable.
- **The 30-day rule mislabels slow employers.** A late response after day 30 flips the label back to positive automatically (labels are computed on read).
- **Role family depends on goal wording.** Renaming a target role between goal versions splits a family; the case/space-insensitive merge only covers cosmetic differences.
- **Missed terms use current requirements.** If a job's description changed between optimization and apply, the recorded terms follow the new description. Rare in practice.
