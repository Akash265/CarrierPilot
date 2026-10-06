# Phase 10a — Outcome Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each application's feature snapshot plus its outcome history into an outcome dataset, and show an `/insights` page with response and interview rates (overall and per dimension), each with sample size and a Wilson confidence interval, plus the spec §16 rejection patterns.

**Architecture:** A new pure package `packages/insights` builds the dataset (labels, role family, dimensions) and the statistics on every request — no new tables, no LLM calls. `packages/applications` writes feature snapshot v2, which adds the required job terms the sent resume missed. One API route (`GET /api/insights`) and one page (`/insights`) in `apps/web`.

**Tech Stack:** TypeScript (ESM, raw-TS workspace packages, no build step), Drizzle ORM on PostgreSQL with RLS (`withUserContext`), Vitest, Next.js 16 App Router (`apps/web`), React 19, Testing Library, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-06-phase-10a-outcome-analytics-design.md` — read it before starting any task.

## Global Constraints

- No new database tables or migrations. No LLM/Anthropic/Voyage calls anywhere in `packages/insights`.
- `packages/insights` has no BullMQ import and performs no writes.
- Every DB read goes through `withUserContext` (RLS). `loadInsightInputs` uses `{ isolationLevel: "repeatable read" }`.
- Never read or return: `applications.notes`, `recruiter_name`, `recruiter_contact`, `salary_notes`, `job_url`, application ids, event `detail` (spec §8).
- Outcome tiers: `"response"` and `"interview"`. Labels: `"positive" | "negative" | "undecided" | "excluded"`.
- Stage order: `applied`=0, `screening`=1, `interviewing`=2, `offer`=3, `accepted`=4, `declined`=4. Response evidence: stage ≥ 1 or a `recruiter_contact`/`interview` event. Interview evidence: stage ≥ 2 or an `interview` event.
- `OUTCOME_UNDECIDED_DAYS`: integer ≥ 1, default 30. `INSIGHTS_MIN_BUCKET`: integer ≥ 2, default 5.
- Role-family threshold: `0.5` (best per-role `scoreRole([role], title)`); ties go to the first listed role; otherwise `"Other"` (key `"__other__"`).
- Wilson interval: 95%, z = 1.96, clamped to [0, 1].
- `standsOut`: `"higher"` if interval low > overall rate; `"lower"` if interval high < overall rate; else `null`. Never on the `"Others"` bucket (key `"__others__"`).
- Company and country breakdowns show at most 15 buckets plus one `"Others"` bucket.
- Score bands: `Under 50` (<50), `50–69` (<70), `70–84` (<85), `85+`. Coverage bands: `Under 50%` (<0.5), `50–79%` (<0.8), `80%+`. Posting-age bands: `0–2 days` (≤2), `3–7 days` (≤7), `8–30 days` (≤30), `31+ days`. (Spec §4.4 wrote "30+", which overlaps "8–30"; `31+` is the non-overlapping reading — Task 9 corrects the spec text.)
- Rejection patterns: terms missed in ≥ 2 negatives, max 20, sorted by negatives desc then term; high-coverage threshold `0.8`.
- UI wording: rates as `22% (11 of 50)`; intervals as `Likely between 13% and 35%.`; flags as `Higher/Lower than your overall rate (n=12)`; never "because", "causes" or "predicts". Caveat text (exact): `With this many comparisons, some differences appear by chance. Flags mark things worth a look, not conclusions.`
- Feature snapshot stays write-once (D116). New snapshots are `snapshotVersion: 2`; v1 snapshots must still parse (missed terms → `null`).
- Test user ids reserved for this phase (verified unused anywhere in the repo on 2026-10-06): `00000000-0000-0000-0000-000000000a01` … `…000000000a06`. Use them exactly as assigned per task; never reuse another file's id.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
  ```
- Run package tests with `pnpm --filter <package> test`. The local Postgres/Redis/MinIO containers must be up (`docker compose -f infra/docker-compose.yml up -d`). In a fresh worktree, run `pnpm --filter web build` once before `pnpm --filter web typecheck` (Next generates types into `.next/`).
- New DECISIONS.md entries start at **D140**.

## File Structure

```
packages/insights/                         NEW package @ai-career/insights
  package.json, tsconfig.json, eslint.config.mjs, vitest.config.ts
  src/index.ts                             public exports
  src/types.ts                             shared types (inputs, records, tiers, labels)
  src/stats/wilson.ts                      wilsonInterval, standsOut
  src/stats/bands.ts                       score/coverage/posting-age bands
  src/stats/dimensions.ts                  the 13 breakdown dimensions
  src/stats/computeInsights.ts             headlines, breakdowns, patterns
  src/dataset/labels.ts                    two-tier labels + last activity
  src/dataset/parseSnapshot.ts             tolerant v1/v2 snapshot reader
  src/dataset/roleFamily.ts                pickGoal, roleFamilyKey, roleLabels
  src/dataset/buildOutcomeDataset.ts       inputs -> OutcomeRecord[]
  src/load/loadInsightInputs.ts            one RLS read (repeatable read)
packages/applications/src/missedTerms.ts   NEW findMissedTerms, joinOptimizedText
packages/applications/src/snapshot.ts      MODIFY -> snapshot v2
packages/applications/src/createApplication.ts  MODIFY -> records missed terms
packages/applications/src/index.ts         MODIFY exports
packages/config/src/env.ts                 MODIFY two settings
.env.example                               MODIFY two settings
apps/web/src/app/api/insights/route.ts     NEW
apps/web/src/app/insights/page.tsx         NEW
apps/web/src/app/insights/InsightsClient.tsx  NEW
apps/web/src/app/page.tsx                  MODIFY nav link
apps/web/src/app/applications/page.tsx     MODIFY nav link
DECISIONS.md, FLOW.md, docs/architecture.md, README.md, the spec   docs
```

---

### Task 1: `packages/insights` scaffold, shared types, Wilson interval and bands

**Files:**
- Create: `packages/insights/package.json`, `packages/insights/tsconfig.json`, `packages/insights/eslint.config.mjs`, `packages/insights/vitest.config.ts`
- Create: `packages/insights/src/types.ts`, `packages/insights/src/stats/wilson.ts`, `packages/insights/src/stats/bands.ts`, `packages/insights/src/index.ts`
- Test: `packages/insights/src/stats/wilson.test.ts`, `packages/insights/src/stats/bands.test.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Produces (`src/types.ts`): `ApplicationStatus`, `Tier`, `TIERS`, `OutcomeLabel`, `TierOutcome`, `InsightApplication`, `InsightEventType`, `InsightEvent`, `InsightGoal`, `InsightInputs`, `Interval`, `DocumentsSent`, `OutcomeRecord` (exact definitions below — later tasks use these names verbatim).
- Produces (`src/stats/wilson.ts`): `wilsonInterval(positives: number, decided: number): Interval`, `standsOut(interval: Interval, overallRate: number): "higher" | "lower" | null`.
- Produces (`src/stats/bands.ts`): `BandResult { key: string; label: string }`, `SCORE_BANDS`, `COVERAGE_BANDS`, `POSTING_AGE_BANDS` (each `readonly BandResult[]`), `scoreBand(score: number): BandResult`, `coverageBand(coverage: number): BandResult`, `postingAgeBand(days: number): BandResult`.

- [ ] **Step 1: Create the package files**

`packages/insights/package.json`:
```json
{
  "name": "@ai-career/insights",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/db": "workspace:*",
    "@ai-career/matching": "workspace:*",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": {
    "@ai-career/applications": "workspace:*",
    "@types/node": "^22.10.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/insights/tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`packages/insights/eslint.config.mjs`:
```js
import baseConfig from "../../eslint.config.base.mjs";

export default baseConfig;
```

`packages/insights/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The loader's integration test migrates and shares the test database, same reason as packages/applications.
    fileParallelism: false,
  },
});
```

`packages/insights/src/types.ts`:
```ts
import type { schema } from "@ai-career/db";

/** Single source of truth: the Postgres enum's values (same as packages/applications). */
export type ApplicationStatus = (typeof schema.applicationStatusEnum.enumValues)[number];

export type Tier = "response" | "interview";
export const TIERS: readonly Tier[] = ["response", "interview"];

export type OutcomeLabel = "positive" | "negative" | "undecided" | "excluded";

export interface TierOutcome {
  label: OutcomeLabel;
  /** Short, user-facing explanation of the label (spec §4.2). */
  reason: string;
}

/** One application as the loader reads it. Never carries notes, recruiter fields, salary notes or the job URL (spec §8). */
export interface InsightApplication {
  id: string;
  jobId: string | null;
  companyName: string;
  jobTitle: string;
  status: ApplicationStatus;
  /** YYYY-MM-DD (UTC calendar date). */
  appliedAt: string;
  createdAt: Date;
  featureSnapshot: unknown;
}

/** Only these three event types are evidence or activity (spec §4.2); the loader reads nothing else. */
export type InsightEventType = "status_change" | "recruiter_contact" | "interview";

export interface InsightEvent {
  applicationId: string;
  type: InsightEventType;
  occurredAt: Date;
  toStatus: ApplicationStatus | null;
}

/** A confirmed career goal with its constraints. */
export interface InsightGoal {
  id: string;
  confirmedAt: Date | null;
  targetRoles: string[];
  salaryFloorNormalized: number | null;
  salaryCurrency: string | null;
  salaryIsParsed: boolean;
}

export interface InsightInputs {
  applications: InsightApplication[];
  events: InsightEvent[];
  goals: InsightGoal[];
}

export interface Interval {
  low: number;
  high: number;
}

export interface DocumentsSent {
  resume: boolean;
  pitch: boolean;
  coverLetter: boolean;
  /** A pitch or cover letter with origin "user_edited" was sent. */
  edited: boolean;
}

/** One application in the outcome dataset (spec §4.4). Every null means "unknown", never zero. */
export interface OutcomeRecord {
  applicationId: string;
  external: boolean;
  appliedAt: string;
  response: TierOutcome;
  interview: TierOutcome;
  roleFamily: { key: string; label: string };
  company: { key: string; label: string };
  workMode: "remote" | "hybrid" | "onsite" | null;
  countryCode: string | null;
  salaryVsFloor: "below" | "at_or_above" | null;
  /** 0-100, only when the match was eligible. */
  matchScore: number | null;
  /** 0-100. */
  atsScore: number | null;
  /** 0-1. */
  requiredKeywordCoverage: number | null;
  postingAgeDays: number | null;
  documents: DocumentsSent | null;
  missedRequiredTerms: string[] | null;
}
```

- [ ] **Step 2: Install so the workspace links the new package**

Run: `pnpm install`
Expected: completes; `pnpm-lock.yaml` gains an `importers` entry for `packages/insights`.

- [ ] **Step 3: Write the failing tests**

`packages/insights/src/stats/wilson.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { standsOut, wilsonInterval } from "./wilson";

describe("wilsonInterval", () => {
  it.each([
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [5, 10, 0.2366, 0.7634],
    [1, 1, 0.2065, 1],
    [11, 50, 0.1275, 0.3524],
    [3, 5, 0.2307, 0.8824],
  ])("%i of %i -> [%f, %f]", (positives, decided, low, high) => {
    const interval = wilsonInterval(positives, decided);
    expect(interval.low).toBeCloseTo(low, 4);
    expect(interval.high).toBeCloseTo(high, 4);
  });

  it("stays inside [0, 1]", () => {
    expect(wilsonInterval(0, 3).low).toBeGreaterThanOrEqual(0);
    expect(wilsonInterval(3, 3).high).toBeLessThanOrEqual(1);
  });

  it("rejects an empty or impossible sample", () => {
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(4, 3)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 3)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 3)).toThrow(RangeError);
  });
});

describe("standsOut", () => {
  it("is higher only when the whole interval is above the overall rate", () => {
    expect(standsOut({ low: 0.31, high: 0.6 }, 0.3)).toBe("higher");
    expect(standsOut({ low: 0.3, high: 0.6 }, 0.3)).toBeNull();
  });

  it("is lower only when the whole interval is below the overall rate", () => {
    expect(standsOut({ low: 0.05, high: 0.29 }, 0.3)).toBe("lower");
    expect(standsOut({ low: 0.05, high: 0.3 }, 0.3)).toBeNull();
  });
});
```

`packages/insights/src/stats/bands.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { coverageBand, postingAgeBand, scoreBand } from "./bands";

describe("bands", () => {
  it.each([
    [0, "lt50"], [49.99, "lt50"], [50, "50-69"], [69.99, "50-69"], [70, "70-84"], [84.99, "70-84"], [85, "85+"], [100, "85+"],
  ])("score %f -> %s", (score, key) => {
    expect(scoreBand(score).key).toBe(key);
  });

  it.each([
    [0, "lt50"], [0.4999, "lt50"], [0.5, "50-79"], [0.7999, "50-79"], [0.8, "80+"], [1, "80+"],
  ])("coverage %f -> %s", (coverage, key) => {
    expect(coverageBand(coverage).key).toBe(key);
  });

  it.each([
    [0, "0-2"], [2, "0-2"], [3, "3-7"], [7, "3-7"], [8, "8-30"], [30, "8-30"], [31, "31+"], [400, "31+"],
  ])("posting age %i days -> %s", (days, key) => {
    expect(postingAgeBand(days).key).toBe(key);
  });

  it("labels bands for display", () => {
    expect(scoreBand(10).label).toBe("Under 50");
    expect(scoreBand(60).label).toBe("50–69");
    expect(coverageBand(0.9).label).toBe("80%+");
    expect(postingAgeBand(40).label).toBe("31+ days");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/insights test`
Expected: FAIL — `Failed to resolve import "./wilson"` / `"./bands"`.

- [ ] **Step 5: Implement**

`packages/insights/src/stats/wilson.ts`:
```ts
import type { Interval } from "../types";

const Z = 1.96;

/**
 * 95% Wilson score interval for positives/decided (spec §5.1). Unlike the plain normal approximation it
 * stays sensible at small n and at 0% or 100%, which is exactly the small personal dataset this serves.
 */
export function wilsonInterval(positives: number, decided: number): Interval {
  if (!Number.isInteger(decided) || decided < 1) throw new RangeError("wilsonInterval: decided must be a positive integer");
  if (!Number.isInteger(positives) || positives < 0 || positives > decided) {
    throw new RangeError("wilsonInterval: positives must be an integer between 0 and decided");
  }
  const p = positives / decided;
  const z2 = Z * Z;
  const denominator = 1 + z2 / decided;
  const centre = (p + z2 / (2 * decided)) / denominator;
  const half = (Z * Math.sqrt((p * (1 - p)) / decided + z2 / (4 * decided * decided))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Spec §5.3: a bucket stands out only when its whole interval clears the overall rate. */
export function standsOut(interval: Interval, overallRate: number): "higher" | "lower" | null {
  if (interval.low > overallRate) return "higher";
  if (interval.high < overallRate) return "lower";
  return null;
}
```

`packages/insights/src/stats/bands.ts`:
```ts
export interface BandResult {
  key: string;
  label: string;
}

export const SCORE_BANDS: readonly BandResult[] = [
  { key: "lt50", label: "Under 50" },
  { key: "50-69", label: "50–69" },
  { key: "70-84", label: "70–84" },
  { key: "85+", label: "85+" },
];

export const COVERAGE_BANDS: readonly BandResult[] = [
  { key: "lt50", label: "Under 50%" },
  { key: "50-79", label: "50–79%" },
  { key: "80+", label: "80%+" },
];

/** "31+" rather than the spec's "30+": 30 already belongs to "8–30". */
export const POSTING_AGE_BANDS: readonly BandResult[] = [
  { key: "0-2", label: "0–2 days" },
  { key: "3-7", label: "3–7 days" },
  { key: "8-30", label: "8–30 days" },
  { key: "31+", label: "31+ days" },
];

/** Match and ATS scores are 0-100. */
export function scoreBand(score: number): BandResult {
  if (score < 50) return SCORE_BANDS[0];
  if (score < 70) return SCORE_BANDS[1];
  if (score < 85) return SCORE_BANDS[2];
  return SCORE_BANDS[3];
}

/** Keyword coverage is 0-1. */
export function coverageBand(coverage: number): BandResult {
  if (coverage < 0.5) return COVERAGE_BANDS[0];
  if (coverage < 0.8) return COVERAGE_BANDS[1];
  return COVERAGE_BANDS[2];
}

export function postingAgeBand(days: number): BandResult {
  if (days <= 2) return POSTING_AGE_BANDS[0];
  if (days <= 7) return POSTING_AGE_BANDS[1];
  if (days <= 30) return POSTING_AGE_BANDS[2];
  return POSTING_AGE_BANDS[3];
}
```

`packages/insights/src/index.ts`:
```ts
export * from "./types";
export { wilsonInterval, standsOut } from "./stats/wilson";
export {
  SCORE_BANDS, COVERAGE_BANDS, POSTING_AGE_BANDS, scoreBand, coverageBand, postingAgeBand, type BandResult,
} from "./stats/bands";
```

- [ ] **Step 6: Run the tests, typecheck and lint**

Run: `pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint`
Expected: all tests PASS; tsc and eslint report nothing.

- [ ] **Step 7: Commit**

```bash
git add packages/insights pnpm-lock.yaml
git commit -m "feat(insights): package scaffold, shared types, Wilson interval and bands (Phase 10a)"
```

---

### Task 2: Two-tier outcome labels

**Files:**
- Create: `packages/insights/src/dataset/labels.ts`
- Test: `packages/insights/src/dataset/labels.test.ts`
- Modify: `packages/insights/src/index.ts`

**Interfaces:**
- Consumes: `ApplicationStatus`, `InsightEvent`, `TierOutcome` (Task 1).
- Produces: `LabelInput { status: ApplicationStatus; appliedAt: string; events: readonly InsightEvent[] }`, `LabelOptions { now: Date; undecidedDays: number }`, `LabelResult { response: TierOutcome; interview: TierOutcome; lastActivityAt: Date }`, `labelOutcome(input: LabelInput, opts: LabelOptions): LabelResult`.

- [ ] **Step 1: Write the failing test**

`packages/insights/src/dataset/labels.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { labelOutcome, type LabelInput } from "./labels";
import type { InsightEvent } from "../types";

const NOW = new Date("2026-10-06T12:00:00Z");
const OPTS = { now: NOW, undecidedDays: 30 };
const ev = (type: InsightEvent["type"], at: string, toStatus: InsightEvent["toStatus"] = null): InsightEvent => ({
  applicationId: "a1", type, occurredAt: new Date(at), toStatus,
});
const input = (over: Partial<LabelInput>): LabelInput => ({ status: "applied", appliedAt: "2026-10-01", events: [], ...over });

describe("labelOutcome", () => {
  it("leaves a fresh open application undecided for both tiers", () => {
    const r = labelOutcome(input({}), OPTS);
    expect(r.response).toEqual({ label: "undecided", reason: "Undecided: last activity on 2026-10-01" });
    expect(r.interview.label).toBe("undecided");
  });

  it("uses history: screening then rejected is a response but not an interview", () => {
    const r = labelOutcome(input({
      status: "rejected",
      events: [ev("status_change", "2026-10-01T09:00:00Z", "applied"), ev("status_change", "2026-10-03T09:00:00Z", "screening"),
        ev("status_change", "2026-10-04T09:00:00Z", "rejected")],
    }), OPTS);
    expect(r.response).toEqual({ label: "positive", reason: "Response: reached screening on 2026-10-03" });
    expect(r.interview).toEqual({ label: "negative", reason: "No interview: rejected" });
  });

  it("counts a recruiter contact as a response and an interview event as both", () => {
    const contact = labelOutcome(input({ events: [ev("recruiter_contact", "2026-10-02T10:00:00Z")] }), OPTS);
    expect(contact.response).toEqual({ label: "positive", reason: "Response: recruiter contact on 2026-10-02" });
    expect(contact.interview.label).toBe("undecided");

    const interview = labelOutcome(input({ status: "rejected", events: [ev("interview", "2026-10-02T10:00:00Z")] }), OPTS);
    expect(interview.response.label).toBe("positive");
    expect(interview.interview).toEqual({ label: "positive", reason: "Interview: interview logged for 2026-10-02" });
  });

  it("picks the earliest evidence for the reason", () => {
    const r = labelOutcome(input({
      status: "interviewing",
      events: [ev("status_change", "2026-10-05T00:00:00Z", "interviewing"), ev("recruiter_contact", "2026-10-02T00:00:00Z")],
    }), OPTS);
    expect(r.response.reason).toBe("Response: recruiter contact on 2026-10-02");
    expect(r.interview.reason).toBe("Interview: reached interviewing on 2026-10-05");
  });

  it("falls back to the current status when no event records the stage", () => {
    const r = labelOutcome(input({ status: "offer" }), OPTS);
    expect(r.response).toEqual({ label: "positive", reason: "Response: status is offer" });
    expect(r.interview).toEqual({ label: "positive", reason: "Interview: status is offer" });
  });

  it("treats accepted and declined (an offer) as positive for both tiers, even straight from applied", () => {
    for (const status of ["accepted", "declined"] as const) {
      const r = labelOutcome(input({ status, events: [ev("status_change", "2026-10-02T00:00:00Z", status)] }), OPTS);
      expect(r.response.label).toBe("positive");
      expect(r.interview.label).toBe("positive");
    }
  });

  it("labels rejected and no_response without evidence negative for both tiers", () => {
    expect(labelOutcome(input({ status: "rejected" }), OPTS).response).toEqual({ label: "negative", reason: "No response: rejected" });
    const noResponse = labelOutcome(input({ status: "no_response" }), OPTS);
    expect(noResponse.response).toEqual({ label: "negative", reason: "No response: marked no response" });
    expect(noResponse.interview).toEqual({ label: "negative", reason: "No interview: marked no response" });
  });

  it("excludes a withdrawal unless the tier already has evidence", () => {
    const plain = labelOutcome(input({ status: "withdrawn" }), OPTS);
    expect(plain.response).toEqual({ label: "excluded", reason: "Excluded: withdrawn" });
    expect(plain.interview.label).toBe("excluded");

    const afterInterview = labelOutcome(input({ status: "withdrawn", events: [ev("interview", "2026-10-02T00:00:00Z")] }), OPTS);
    expect(afterInterview.response.label).toBe("positive");
    expect(afterInterview.interview.label).toBe("positive");
  });

  it("turns an idle open application negative exactly at the cutoff", () => {
    const base = input({ appliedAt: "2026-09-06" });
    const atCutoff = new Date("2026-10-06T00:00:00Z");
    expect(labelOutcome(base, { now: new Date(atCutoff.getTime() - 1), undecidedDays: 30 }).response.label).toBe("undecided");
    const r = labelOutcome(base, { now: atCutoff, undecidedDays: 30 });
    expect(r.response).toEqual({ label: "negative", reason: "No response: no activity for 30 days" });
    expect(r.interview).toEqual({ label: "negative", reason: "No interview: no activity for 30 days" });
  });

  it("applies the idle rule per tier: screening that went quiet is a response but no interview", () => {
    const r = labelOutcome(input({
      status: "screening", appliedAt: "2026-08-01", events: [ev("status_change", "2026-08-03T00:00:00Z", "screening")],
    }), OPTS);
    expect(r.response.label).toBe("positive");
    expect(r.interview).toEqual({ label: "negative", reason: "No interview: no activity for 30 days" });
  });

  it("measures activity from status changes and contacts, and ignores other event types", () => {
    const recent = labelOutcome(input({
      appliedAt: "2026-08-01", events: [ev("status_change", "2026-10-01T00:00:00Z", "applied")],
    }), OPTS);
    expect(recent.response.label).toBe("undecided");
    expect(recent.lastActivityAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");

    const noteOnly = labelOutcome(input({
      appliedAt: "2026-08-01",
      events: [{ applicationId: "a1", type: "note" as never, occurredAt: new Date("2026-10-05T00:00:00Z"), toStatus: null }],
    }), OPTS);
    expect(noteOnly.response.label).toBe("negative");
    expect(noteOnly.lastActivityAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("counts a future-dated interview as evidence", () => {
    const r = labelOutcome(input({ events: [ev("interview", "2026-10-20T09:00:00Z")] }), OPTS);
    expect(r.interview.label).toBe("positive");
  });

  it("never lets an offer fall to the idle rule for the interview tier", () => {
    const r = labelOutcome(input({ status: "offer", appliedAt: "2026-06-01" }), OPTS);
    expect(r.interview.label).toBe("positive");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/insights test -- src/dataset/labels.test.ts`
Expected: FAIL — `Failed to resolve import "./labels"`.

- [ ] **Step 3: Implement**

`packages/insights/src/dataset/labels.ts`:
```ts
import type { ApplicationStatus, InsightEvent, TierOutcome } from "../types";

const MS_PER_DAY = 86_400_000;

/** Spec §4.1. Endings (rejected, withdrawn, no_response) are not stages. */
const STAGE: Partial<Record<ApplicationStatus, number>> = {
  applied: 0, screening: 1, interviewing: 2, offer: 3, accepted: 4, declined: 4,
};
const RESPONSE_STAGE = 1;
const INTERVIEW_STAGE = 2;
const REACHED_TEXT: Partial<Record<ApplicationStatus, string>> = {
  screening: "screening", interviewing: "interviewing", offer: "an offer", accepted: "an accepted offer", declined: "a declined offer",
};
const ACTIVITY_TYPES = new Set(["status_change", "recruiter_contact", "interview"]);

export interface LabelInput {
  status: ApplicationStatus;
  /** YYYY-MM-DD. */
  appliedAt: string;
  /** This application's events. Types other than the three activity types are ignored. */
  events: readonly InsightEvent[];
}

export interface LabelOptions {
  now: Date;
  undecidedDays: number;
}

export interface LabelResult {
  response: TierOutcome;
  interview: TierOutcome;
  lastActivityAt: Date;
}

interface Evidence {
  /** null for evidence that only the current status provides (no dated event). */
  at: Date | null;
  text: string;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const stageOf = (status: ApplicationStatus | null): number => (status === null ? -1 : (STAGE[status] ?? -1));

function stageEvidence(input: LabelInput, minStage: number): Evidence[] {
  const found: Evidence[] = [];
  for (const e of input.events) {
    if (e.type === "status_change" && e.toStatus !== null && stageOf(e.toStatus) >= minStage) {
      found.push({ at: e.occurredAt, text: `reached ${REACHED_TEXT[e.toStatus]} on ${day(e.occurredAt)}` });
    }
  }
  if (stageOf(input.status) >= minStage) found.push({ at: null, text: `status is ${input.status}` });
  return found;
}

/** Dated evidence wins over undated (current-status) evidence; among dated, the earliest. */
function earliest(list: Evidence[]): Evidence | null {
  let best: Evidence | null = null;
  for (const e of list) {
    if (best === null || (e.at !== null && (best.at === null || e.at < best.at))) best = e;
  }
  return best;
}

function decide(
  words: { positive: string; negative: string },
  evidence: Evidence[],
  input: LabelInput,
  lastActivityMs: number,
  opts: LabelOptions
): TierOutcome {
  const found = earliest(evidence);
  if (found) return { label: "positive", reason: `${words.positive}: ${found.text}` };
  if (input.status === "withdrawn") return { label: "excluded", reason: "Excluded: withdrawn" };
  if (input.status === "rejected") return { label: "negative", reason: `${words.negative}: rejected` };
  if (input.status === "no_response") return { label: "negative", reason: `${words.negative}: marked no response` };
  // accepted/declined always carry stage evidence, so only open statuses reach the idle rule.
  if (opts.now.getTime() - lastActivityMs >= opts.undecidedDays * MS_PER_DAY) {
    return { label: "negative", reason: `${words.negative}: no activity for ${opts.undecidedDays} days` };
  }
  return { label: "undecided", reason: `Undecided: last activity on ${day(new Date(lastActivityMs))}` };
}

/**
 * Spec §4.1-4.2. Labels come from the furthest stage ever reached (status_change history) plus logged
 * recruiter-contact/interview events -- not just the current status -- so screening -> rejected still
 * counts as a response. Evidence always wins; withdrawn is excluded, never negative.
 */
export function labelOutcome(input: LabelInput, opts: LabelOptions): LabelResult {
  const events = input.events.filter((e) => ACTIVITY_TYPES.has(e.type));
  const scoped: LabelInput = { ...input, events };

  let lastActivityMs = Date.parse(`${input.appliedAt}T00:00:00Z`);
  for (const e of events) lastActivityMs = Math.max(lastActivityMs, e.occurredAt.getTime());

  const contacts: Evidence[] = events
    .filter((e) => e.type === "recruiter_contact")
    .map((e) => ({ at: e.occurredAt, text: `recruiter contact on ${day(e.occurredAt)}` }));
  const interviews: Evidence[] = events
    .filter((e) => e.type === "interview")
    .map((e) => ({ at: e.occurredAt, text: `interview logged for ${day(e.occurredAt)}` }));

  return {
    response: decide(
      { positive: "Response", negative: "No response" },
      [...stageEvidence(scoped, RESPONSE_STAGE), ...contacts, ...interviews], scoped, lastActivityMs, opts
    ),
    interview: decide(
      { positive: "Interview", negative: "No interview" },
      [...stageEvidence(scoped, INTERVIEW_STAGE), ...interviews], scoped, lastActivityMs, opts
    ),
    lastActivityAt: new Date(lastActivityMs),
  };
}
```

Add to `packages/insights/src/index.ts`:
```ts
export { labelOutcome, type LabelInput, type LabelOptions, type LabelResult } from "./dataset/labels";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint`
Expected: PASS; no tsc/eslint output.

- [ ] **Step 5: Commit**

```bash
git add packages/insights/src
git commit -m "feat(insights): two-tier outcome labels from stage history and events (Phase 10a)"
```

---

### Task 3: Snapshot parser, role family and the outcome dataset

**Files:**
- Create: `packages/insights/src/dataset/parseSnapshot.ts`, `packages/insights/src/dataset/roleFamily.ts`, `packages/insights/src/dataset/buildOutcomeDataset.ts`
- Test: `packages/insights/src/dataset/parseSnapshot.test.ts`, `packages/insights/src/dataset/roleFamily.test.ts`, `packages/insights/src/dataset/buildOutcomeDataset.test.ts`
- Modify: `packages/insights/src/index.ts`

**Interfaces:**
- Consumes: Task 1 types; `labelOutcome` (Task 2); `scoreRole(targetRoles: string[], jobTitle: string): number` from `@ai-career/matching`.
- Produces: `ParsedSnapshot`, `parseSnapshot(raw: unknown): ParsedSnapshot`; `OTHER_FAMILY = { key: "__other__", label: "Other" }`, `ROLE_MATCH_THRESHOLD = 0.5`, `roleKey(role: string): string`, `pickGoal(createdAt: Date, snapshotGoalId: string | null, goals: readonly InsightGoal[]): InsightGoal | null`, `roleFamilyKey(jobTitle: string, goal: InsightGoal | null): string`, `roleLabels(goals: readonly InsightGoal[]): Map<string, string>`; `salaryVsFloor(snapshot: ParsedSnapshot, goal: InsightGoal | null): "below" | "at_or_above" | null`, `buildOutcomeDataset(inputs: InsightInputs, opts: { now: Date; undecidedDays: number }): OutcomeRecord[]` (records ordered most recently applied first).

- [ ] **Step 1: Write the failing tests**

`packages/insights/src/dataset/parseSnapshot.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseSnapshot } from "./parseSnapshot";

const V2 = {
  snapshotVersion: 2,
  external: false,
  job: { title: "Data Engineer", companyName: "Acme", workMode: "remote", countryCode: "de", salaryMin: 70000, salaryMax: 90000,
    salaryCurrency: "EUR", postingAgeDays: 4 },
  match: { careerGoalId: "g1", eligible: true, overallScore: 78 },
  ats: { overallScore: 82, requiredKeywordCoverage: 0.9, preferredKeywordCoverage: 0.5, semanticSimilarity: null,
    missedRequiredTerms: ["Tableau", " ", 7] },
  documents: {
    resume: { id: "r1", version: 1, origin: null },
    pitch: { id: "p1", version: 2, origin: "user_edited" },
    coverLetter: null,
  },
};

describe("parseSnapshot", () => {
  it("reads a v2 snapshot", () => {
    expect(parseSnapshot(V2)).toEqual({
      external: false, careerGoalId: "g1", matchScore: 78, workMode: "remote", countryCode: "DE",
      salaryMin: 70000, salaryMax: 90000, salaryCurrency: "EUR", postingAgeDays: 4, atsScore: 82, requiredKeywordCoverage: 0.9,
      missedRequiredTerms: ["Tableau"], documents: { resume: true, pitch: true, coverLetter: false, edited: true },
    });
  });

  it("reads a v1 snapshot with missed terms unknown", () => {
    const { ats, ...rest } = V2;
    const { missedRequiredTerms, ...v1Ats } = ats;
    expect(parseSnapshot({ ...rest, snapshotVersion: 1, ats: v1Ats }).missedRequiredTerms).toBeNull();
  });

  it("drops the match score of an ineligible match, and an unknown work mode", () => {
    const parsed = parseSnapshot({ ...V2, match: { ...V2.match, eligible: false }, job: { ...V2.job, workMode: "unknown" } });
    expect(parsed.matchScore).toBeNull();
    expect(parsed.careerGoalId).toBe("g1");
    expect(parsed.workMode).toBeNull();
  });

  it("reads an external snapshot as external with nothing else known", () => {
    expect(parseSnapshot({
      snapshotVersion: 2, external: true, job: { title: "Analyst", companyName: "Globex", workMode: null }, match: null, ats: null, documents: null,
    })).toEqual({
      external: true, careerGoalId: null, matchScore: null, workMode: null, countryCode: null, salaryMin: null, salaryMax: null,
      salaryCurrency: null, postingAgeDays: null, atsScore: null, requiredKeywordCoverage: null, missedRequiredTerms: null, documents: null,
    });
  });

  it.each([null, "x", 42, [], { job: "nope", match: [1], ats: "x", documents: 5 }])("never throws on a malformed snapshot (%j)", (raw) => {
    const parsed = parseSnapshot(raw);
    expect(parsed.external).toBe(false);
    expect(parsed.matchScore).toBeNull();
    expect(parsed.documents).toBeNull();
  });

  it("rejects non-finite numbers", () => {
    expect(parseSnapshot({ ...V2, ats: { ...V2.ats, overallScore: "82" } }).atsScore).toBeNull();
  });
});
```

`packages/insights/src/dataset/roleFamily.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { OTHER_FAMILY, pickGoal, roleFamilyKey, roleLabels } from "./roleFamily";
import type { InsightGoal } from "../types";

const goal = (over: Partial<InsightGoal>): InsightGoal => ({
  id: "g1", confirmedAt: new Date("2026-09-01T00:00:00Z"), targetRoles: [], salaryFloorNormalized: null, salaryCurrency: null,
  salaryIsParsed: false, ...over,
});

describe("roleFamilyKey", () => {
  it("picks the best-matching target role", () => {
    const g = goal({ targetRoles: ["Data Analyst", "Data Engineer"] });
    expect(roleFamilyKey("Senior Data Engineer II", g)).toBe("data engineer");
  });

  it("breaks a tie in favour of the first listed role", () => {
    const g = goal({ targetRoles: ["Data Analyst", "Data Engineer"] });
    expect(roleFamilyKey("Data Person", g)).toBe("data analyst");
  });

  it("is Other below the 0.5 threshold, with no goal, or with no usable roles", () => {
    expect(roleFamilyKey("Head of Marketing Operations", goal({ targetRoles: ["Data Engineer"] }))).toBe(OTHER_FAMILY.key);
    expect(roleFamilyKey("Data Engineer", null)).toBe(OTHER_FAMILY.key);
    expect(roleFamilyKey("Data Engineer", goal({ targetRoles: [] }))).toBe(OTHER_FAMILY.key);
    expect(roleFamilyKey("Data Engineer", goal({ targetRoles: ["—", "  "] }))).toBe(OTHER_FAMILY.key);
  });

  it("keys roles case- and space-insensitively", () => {
    expect(roleFamilyKey("Data Engineer", goal({ targetRoles: ["  DATA   Engineer "] }))).toBe("data engineer");
  });
});

describe("pickGoal", () => {
  const older = goal({ id: "old", confirmedAt: new Date("2026-08-01T00:00:00Z") });
  const newer = goal({ id: "new", confirmedAt: new Date("2026-09-15T00:00:00Z") });

  it("uses the match's goal when it exists", () => {
    expect(pickGoal(new Date("2026-10-01T00:00:00Z"), "old", [older, newer])?.id).toBe("old");
  });

  it("otherwise uses the goal confirmed most recently before the application was created", () => {
    expect(pickGoal(new Date("2026-09-10T00:00:00Z"), null, [older, newer])?.id).toBe("old");
    expect(pickGoal(new Date("2026-10-01T00:00:00Z"), "missing", [older, newer])?.id).toBe("new");
  });

  it("is null when no goal was confirmed by then", () => {
    expect(pickGoal(new Date("2026-07-01T00:00:00Z"), null, [older, newer])).toBeNull();
    expect(pickGoal(new Date("2026-10-01T00:00:00Z"), null, [goal({ confirmedAt: null })])).toBeNull();
  });
});

describe("roleLabels", () => {
  it("labels each role key with the most recently confirmed goal's spelling", () => {
    const labels = roleLabels([
      goal({ id: "b", confirmedAt: new Date("2026-09-15T00:00:00Z"), targetRoles: ["Data Engineer"] }),
      goal({ id: "a", confirmedAt: new Date("2026-08-01T00:00:00Z"), targetRoles: ["data engineer", "Analyst"] }),
    ]);
    expect(labels.get("data engineer")).toBe("Data Engineer");
    expect(labels.get("analyst")).toBe("Analyst");
  });
});
```

`packages/insights/src/dataset/buildOutcomeDataset.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildOutcomeDataset, salaryVsFloor } from "./buildOutcomeDataset";
import { parseSnapshot } from "./parseSnapshot";
import type { InsightApplication, InsightGoal, InsightInputs } from "../types";

const NOW = new Date("2026-10-06T12:00:00Z");
const OPTS = { now: NOW, undecidedDays: 30 };
const GOAL: InsightGoal = {
  id: "g1", confirmedAt: new Date("2026-09-01T00:00:00Z"), targetRoles: ["Data Engineer", "Analytics Engineer"],
  salaryFloorNormalized: 80000, salaryCurrency: "EUR", salaryIsParsed: true,
};
const SNAPSHOT = {
  snapshotVersion: 2, external: false,
  job: { workMode: "hybrid", countryCode: "DE", salaryMin: 70000, salaryMax: 75000, salaryCurrency: "EUR", postingAgeDays: 3 },
  match: { careerGoalId: "g1", eligible: true, overallScore: 72 },
  ats: { overallScore: 88, requiredKeywordCoverage: 0.5, missedRequiredTerms: ["Tableau"] },
  documents: { resume: { origin: null }, pitch: null, coverLetter: null },
};
const app = (over: Partial<InsightApplication>): InsightApplication => ({
  id: "a1", jobId: "j1", companyName: "Acme", jobTitle: "Senior Data Engineer", status: "applied", appliedAt: "2026-10-01",
  createdAt: new Date("2026-10-01T08:00:00Z"), featureSnapshot: SNAPSHOT, ...over,
});

describe("buildOutcomeDataset", () => {
  it("builds one record per application with labels, role family and dimensions", () => {
    const inputs: InsightInputs = {
      applications: [app({ status: "rejected" })],
      events: [{ applicationId: "a1", type: "status_change", occurredAt: new Date("2026-10-03T00:00:00Z"), toStatus: "screening" }],
      goals: [GOAL],
    };
    const [record] = buildOutcomeDataset(inputs, OPTS);
    expect(record).toEqual({
      applicationId: "a1", external: false, appliedAt: "2026-10-01",
      response: { label: "positive", reason: "Response: reached screening on 2026-10-03" },
      interview: { label: "negative", reason: "No interview: rejected" },
      roleFamily: { key: "data engineer", label: "Data Engineer" },
      company: { key: "acme", label: "Acme" },
      workMode: "hybrid", countryCode: "DE", salaryVsFloor: "below", matchScore: 72, atsScore: 88, requiredKeywordCoverage: 0.5,
      postingAgeDays: 3, documents: { resume: true, pitch: false, coverLetter: false, edited: false }, missedRequiredTerms: ["Tableau"],
    });
  });

  it("only routes each application's own events to it", () => {
    const inputs: InsightInputs = {
      applications: [app({ id: "a1" }), app({ id: "a2" })],
      events: [{ applicationId: "a2", type: "interview", occurredAt: new Date("2026-10-02T00:00:00Z"), toStatus: null }],
      goals: [GOAL],
    };
    const byId = new Map(buildOutcomeDataset(inputs, OPTS).map((r) => [r.applicationId, r]));
    expect(byId.get("a1")!.interview.label).toBe("undecided");
    expect(byId.get("a2")!.interview.label).toBe("positive");
  });

  it("orders records most recently applied first, and keys companies case-insensitively", () => {
    const records = buildOutcomeDataset({
      applications: [
        app({ id: "old", appliedAt: "2026-09-01", companyName: "acme  corp" }),
        app({ id: "new", appliedAt: "2026-10-02", companyName: " Acme Corp" }),
      ],
      events: [], goals: [GOAL],
    }, OPTS);
    expect(records.map((r) => r.applicationId)).toEqual(["new", "old"]);
    expect(records.map((r) => r.company.key)).toEqual(["acme corp", "acme corp"]);
    expect(records[0].company.label).toBe("Acme Corp");
  });

  it("gives an external application only role family and company", () => {
    const [record] = buildOutcomeDataset({
      applications: [app({
        jobId: null, jobTitle: "Analytics Engineer", createdAt: new Date("2026-10-01T00:00:00Z"),
        featureSnapshot: { snapshotVersion: 2, external: true, job: { workMode: null }, match: null, ats: null, documents: null },
      })],
      events: [], goals: [GOAL],
    }, OPTS);
    expect(record).toMatchObject({
      external: true, roleFamily: { key: "analytics engineer", label: "Analytics Engineer" }, company: { key: "acme" },
      workMode: null, countryCode: null, salaryVsFloor: null, matchScore: null, atsScore: null, requiredKeywordCoverage: null,
      postingAgeDays: null, documents: null, missedRequiredTerms: null,
    });
  });

  it("survives a malformed snapshot with only the application's own columns", () => {
    const [record] = buildOutcomeDataset({ applications: [app({ featureSnapshot: "garbage" })], events: [], goals: [GOAL] }, OPTS);
    expect(record.company.label).toBe("Acme");
    expect(record.roleFamily.key).toBe("data engineer");
    expect(record.matchScore).toBeNull();
  });
});

describe("salaryVsFloor", () => {
  const snap = (job: Record<string, unknown>) => parseSnapshot({ job });

  it("compares the job's max (else min) annual salary with the floor", () => {
    expect(salaryVsFloor(snap({ salaryMin: 70000, salaryMax: 90000, salaryCurrency: "EUR" }), GOAL)).toBe("at_or_above");
    expect(salaryVsFloor(snap({ salaryMin: 80000, salaryMax: null, salaryCurrency: "eur" }), GOAL)).toBe("at_or_above");
    expect(salaryVsFloor(snap({ salaryMin: 60000, salaryMax: 79999, salaryCurrency: "EUR" }), GOAL)).toBe("below");
  });

  it("is unknown without a salary, a parsed floor, a goal, or a matching currency", () => {
    expect(salaryVsFloor(snap({ salaryCurrency: "EUR" }), GOAL)).toBeNull();
    expect(salaryVsFloor(snap({ salaryMax: 90000, salaryCurrency: "USD" }), GOAL)).toBeNull();
    expect(salaryVsFloor(snap({ salaryMax: 90000, salaryCurrency: "EUR" }), { ...GOAL, salaryIsParsed: false })).toBeNull();
    expect(salaryVsFloor(snap({ salaryMax: 90000, salaryCurrency: "EUR" }), null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/insights test`
Expected: FAIL — unresolved imports `./parseSnapshot`, `./roleFamily`, `./buildOutcomeDataset`.

- [ ] **Step 3: Implement**

`packages/insights/src/dataset/parseSnapshot.ts`:
```ts
import type { DocumentsSent } from "../types";

/** The parts of a feature snapshot (v1 or v2, packages/applications/src/snapshot.ts) the dataset uses. */
export interface ParsedSnapshot {
  external: boolean;
  careerGoalId: string | null;
  /** 0-100; only for an eligible match. */
  matchScore: number | null;
  workMode: "remote" | "hybrid" | "onsite" | null;
  countryCode: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postingAgeDays: number | null;
  atsScore: number | null;
  requiredKeywordCoverage: number | null;
  /** v2 only; null for v1 snapshots and for applications sent without an optimized resume. */
  missedRequiredTerms: string[] | null;
  documents: DocumentsSent | null;
}

type Obj = Record<string, unknown>;
const WORK_MODES = new Set(["remote", "hybrid", "onsite"]);

const obj = (value: unknown): Obj | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

/**
 * Spec §6: tolerant by design. The snapshot is stored jsonb written by an older or newer version of the code,
 * so every field is checked by hand and anything unexpected becomes null ("unknown") instead of an error.
 */
export function parseSnapshot(raw: unknown): ParsedSnapshot {
  const snapshot = obj(raw) ?? {};
  const job = obj(snapshot.job) ?? {};
  const match = obj(snapshot.match);
  const ats = obj(snapshot.ats);
  const documents = obj(snapshot.documents);
  const workMode = str(job.workMode);
  const missed = ats && Array.isArray(ats.missedRequiredTerms)
    ? ats.missedRequiredTerms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
    : null;

  return {
    external: snapshot.external === true,
    careerGoalId: match ? str(match.careerGoalId) : null,
    matchScore: match && match.eligible === true ? num(match.overallScore) : null,
    workMode: workMode !== null && WORK_MODES.has(workMode) ? (workMode as "remote" | "hybrid" | "onsite") : null,
    countryCode: str(job.countryCode)?.toUpperCase() ?? null,
    salaryMin: num(job.salaryMin),
    salaryMax: num(job.salaryMax),
    salaryCurrency: str(job.salaryCurrency),
    postingAgeDays: num(job.postingAgeDays),
    atsScore: ats ? num(ats.overallScore) : null,
    requiredKeywordCoverage: ats ? num(ats.requiredKeywordCoverage) : null,
    missedRequiredTerms: missed,
    documents: documents
      ? {
          resume: obj(documents.resume) !== null,
          pitch: obj(documents.pitch) !== null,
          coverLetter: obj(documents.coverLetter) !== null,
          edited: [documents.pitch, documents.coverLetter].some((d) => obj(d)?.origin === "user_edited"),
        }
      : null,
  };
}
```

`packages/insights/src/dataset/roleFamily.ts`:
```ts
import { scoreRole } from "@ai-career/matching";
import type { InsightGoal } from "../types";

export const OTHER_FAMILY = { key: "__other__", label: "Other" } as const;
export const ROLE_MATCH_THRESHOLD = 0.5;

/** Merges the same role written with different casing/spacing across goal versions (spec §4.3). */
export const roleKey = (role: string): string => role.trim().toLowerCase().replace(/\s+/g, " ");
/** scoreRole treats a role with no word characters as a neutral 0.5; such a role must never win. */
const hasWord = (role: string): boolean => /[a-z0-9]/i.test(role);

/** Spec §4.3 step 1: the match's goal, else the goal confirmed most recently before the application was created. */
export function pickGoal(createdAt: Date, snapshotGoalId: string | null, goals: readonly InsightGoal[]): InsightGoal | null {
  if (snapshotGoalId !== null) {
    const fromMatch = goals.find((g) => g.id === snapshotGoalId);
    if (fromMatch) return fromMatch;
  }
  let best: InsightGoal | null = null;
  for (const g of goals) {
    if (g.confirmedAt === null || g.confirmedAt > createdAt) continue;
    if (best === null || g.confirmedAt > (best.confirmedAt as Date)) best = g;
  }
  return best;
}

/** Spec §4.3 step 2: the best-scoring target role (first wins a tie) if it reaches the threshold, else Other. */
export function roleFamilyKey(jobTitle: string, goal: InsightGoal | null): string {
  if (goal === null) return OTHER_FAMILY.key;
  let bestKey: string | null = null;
  let bestScore = -1;
  for (const role of goal.targetRoles) {
    if (!hasWord(role)) continue;
    const score = scoreRole([role], jobTitle);
    if (score > bestScore) {
      bestScore = score;
      bestKey = roleKey(role);
    }
  }
  return bestKey !== null && bestScore >= ROLE_MATCH_THRESHOLD ? bestKey : OTHER_FAMILY.key;
}

/** Role key -> display text, from the most recently confirmed goal that lists the role. */
export function roleLabels(goals: readonly InsightGoal[]): Map<string, string> {
  const oldestFirst = [...goals].sort((a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0));
  const labels = new Map<string, string>();
  for (const g of oldestFirst) {
    for (const role of g.targetRoles) if (hasWord(role)) labels.set(roleKey(role), role.trim().replace(/\s+/g, " "));
  }
  return labels;
}
```

`packages/insights/src/dataset/buildOutcomeDataset.ts`:
```ts
import type { InsightEvent, InsightGoal, InsightInputs, OutcomeRecord } from "../types";
import { labelOutcome } from "./labels";
import { parseSnapshot, type ParsedSnapshot } from "./parseSnapshot";
import { OTHER_FAMILY, pickGoal, roleFamilyKey, roleLabels } from "./roleFamily";

/** Spec §4.4: job salaries are stored annualized, and the goal's floor is annual. Currency must match (D6: never convert). */
export function salaryVsFloor(snapshot: ParsedSnapshot, goal: InsightGoal | null): "below" | "at_or_above" | null {
  if (goal === null || !goal.salaryIsParsed || goal.salaryFloorNormalized === null || goal.salaryCurrency === null) return null;
  const figure = snapshot.salaryMax ?? snapshot.salaryMin;
  if (figure === null || snapshot.salaryCurrency === null) return null;
  if (snapshot.salaryCurrency.toUpperCase() !== goal.salaryCurrency.toUpperCase()) return null;
  return figure < goal.salaryFloorNormalized ? "below" : "at_or_above";
}

const companyKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Spec §4. Pure: one record per application, most recently applied first (so the first record of a company
 * or role carries its most recent spelling). Never throws on a malformed snapshot.
 */
export function buildOutcomeDataset(inputs: InsightInputs, opts: { now: Date; undecidedDays: number }): OutcomeRecord[] {
  const eventsByApplication = new Map<string, InsightEvent[]>();
  for (const e of inputs.events) {
    const list = eventsByApplication.get(e.applicationId) ?? [];
    list.push(e);
    eventsByApplication.set(e.applicationId, list);
  }
  const labels = roleLabels(inputs.goals);
  const ordered = [...inputs.applications].sort(
    (a, b) => b.appliedAt.localeCompare(a.appliedAt) || b.createdAt.getTime() - a.createdAt.getTime()
  );

  return ordered.map((application): OutcomeRecord => {
    const snapshot = parseSnapshot(application.featureSnapshot);
    const outcome = labelOutcome(
      { status: application.status, appliedAt: application.appliedAt, events: eventsByApplication.get(application.id) ?? [] },
      opts
    );
    const goal = pickGoal(application.createdAt, snapshot.careerGoalId, inputs.goals);
    const familyKey = roleFamilyKey(application.jobTitle, goal);
    return {
      applicationId: application.id,
      external: snapshot.external,
      appliedAt: application.appliedAt,
      response: outcome.response,
      interview: outcome.interview,
      roleFamily: familyKey === OTHER_FAMILY.key ? { ...OTHER_FAMILY } : { key: familyKey, label: labels.get(familyKey) ?? familyKey },
      company: { key: companyKey(application.companyName), label: application.companyName.trim().replace(/\s+/g, " ") },
      workMode: snapshot.workMode,
      countryCode: snapshot.countryCode,
      salaryVsFloor: salaryVsFloor(snapshot, goal),
      matchScore: snapshot.matchScore,
      atsScore: snapshot.atsScore,
      requiredKeywordCoverage: snapshot.requiredKeywordCoverage,
      postingAgeDays: snapshot.postingAgeDays,
      documents: snapshot.documents,
      missedRequiredTerms: snapshot.missedRequiredTerms,
    };
  });
}
```

Add to `packages/insights/src/index.ts`:
```ts
export { parseSnapshot, type ParsedSnapshot } from "./dataset/parseSnapshot";
export { OTHER_FAMILY, ROLE_MATCH_THRESHOLD, roleKey, pickGoal, roleFamilyKey, roleLabels } from "./dataset/roleFamily";
export { buildOutcomeDataset, salaryVsFloor } from "./dataset/buildOutcomeDataset";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint`
Expected: PASS; no tsc/eslint output.

- [ ] **Step 5: Commit**

```bash
git add packages/insights/src
git commit -m "feat(insights): tolerant snapshot parser, role family and the outcome dataset (Phase 10a)"
```

---

### Task 4: Statistics — dimensions, headlines, breakdowns and rejection patterns

**Files:**
- Create: `packages/insights/src/stats/dimensions.ts`, `packages/insights/src/stats/computeInsights.ts`
- Test: `packages/insights/src/stats/computeInsights.test.ts`
- Modify: `packages/insights/src/index.ts`

**Interfaces:**
- Consumes: `OutcomeRecord`, `Tier`, `TIERS`, `Interval` (Task 1); `wilsonInterval`, `standsOut`, bands (Task 1).
- Produces:
  - `DimensionKey = "roleFamily" | "company" | "workMode" | "country" | "salaryVsFloor" | "matchScore" | "atsScore" | "keywordCoverage" | "postingAge" | "resumeSent" | "pitchSent" | "coverLetterSent" | "edited"`; `DIMENSIONS: readonly DimensionDef[]` (in that order).
  - `Headline { decided; positives; negatives; undecided; excluded: number; rate: number | null; interval: Interval | null }`
  - `Bucket { key: string; label: string; decided: number; positives: number; undecided: number; rate: number | null; interval: Interval | null; standsOut: "higher" | "lower" | null }`
  - `Dimension { key: DimensionKey; title: string; buckets: Bucket[]; unknownCount: number }`
  - `MissedTermPattern { term: string; missedInNegatives: number; missedInPositives: number; negativesWithData: number; positivesWithData: number }`
  - `HighCoveragePattern { decided: number; positives: number; rate: number; interval: Interval; standsOut: "higher" | "lower" | null }`
  - `Patterns { tier: Tier; missedTerms: MissedTermPattern[]; highCoverage: HighCoveragePattern | null }`
  - `Insights { totals: { applications: number; external: number }; tiers: Record<Tier, Headline>; breakdowns: Record<Tier, Dimension[]>; patterns: Patterns }`
  - `computeInsights(records: readonly OutcomeRecord[], opts: { minBucket: number }): Insights`
  - constants `OTHERS_KEY = "__others__"`, `BREAKDOWN_CAP = 15`, `HIGH_COVERAGE_THRESHOLD = 0.8`, `MIN_TERM_NEGATIVES = 2`, `MAX_MISSED_TERMS = 20`.

- [ ] **Step 1: Write the failing test**

`packages/insights/src/stats/computeInsights.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeInsights, OTHERS_KEY } from "./computeInsights";
import type { OutcomeLabel, OutcomeRecord } from "../types";

let seq = 0;
function record(response: OutcomeLabel, interview: OutcomeLabel, over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  seq += 1;
  return {
    applicationId: `a${seq}`, external: false, appliedAt: "2026-10-01",
    response: { label: response, reason: "" }, interview: { label: interview, reason: "" },
    roleFamily: { key: "data engineer", label: "Data Engineer" }, company: { key: "acme", label: "Acme" },
    workMode: "remote", countryCode: "DE", salaryVsFloor: null, matchScore: 72, atsScore: 88, requiredKeywordCoverage: 0.9,
    postingAgeDays: 3, documents: { resume: true, pitch: false, coverLetter: false, edited: false }, missedRequiredTerms: null,
    ...over,
  };
}
const times = (n: number, make: () => OutcomeRecord) => Array.from({ length: n }, make);

describe("computeInsights headlines", () => {
  it("counts every label and gives a rate with an interval at or above the minimum", () => {
    const records = [
      ...times(2, () => record("positive", "positive")),
      ...times(3, () => record("negative", "negative")),
      record("undecided", "undecided"),
      record("excluded", "excluded", { external: true }),
    ];
    const insights = computeInsights(records, { minBucket: 5 });
    expect(insights.totals).toEqual({ applications: 7, external: 1 });
    expect(insights.tiers.response).toMatchObject({ decided: 5, positives: 2, negatives: 3, undecided: 1, excluded: 1, rate: 0.4 });
    expect(insights.tiers.response.interval!.low).toBeCloseTo(0.1176, 4);
    expect(insights.tiers.response.interval!.high).toBeCloseTo(0.7693, 4);
  });

  it("shows counts but no rate below the minimum", () => {
    const insights = computeInsights(times(4, () => record("positive", "negative")), { minBucket: 5 });
    expect(insights.tiers.response).toMatchObject({ decided: 4, positives: 4, rate: null, interval: null });
  });

  it("handles an empty dataset", () => {
    const insights = computeInsights([], { minBucket: 5 });
    expect(insights.totals).toEqual({ applications: 0, external: 0 });
    expect(insights.tiers.interview).toEqual({ decided: 0, positives: 0, negatives: 0, undecided: 0, excluded: 0, rate: null, interval: null });
    expect(insights.breakdowns.response.every((d) => d.buckets.length === 0 && d.unknownCount === 0)).toBe(true);
    expect(insights.patterns).toEqual({ tier: "response", missedTerms: [], highCoverage: null });
  });
});

describe("computeInsights breakdowns", () => {
  const dimension = (insights: ReturnType<typeof computeInsights>, key: string, tier: "response" | "interview" = "response") =>
    insights.breakdowns[tier].find((d) => d.key === key)!;

  it("lists all 13 dimensions in the documented order", () => {
    expect(computeInsights([], { minBucket: 2 }).breakdowns.response.map((d) => d.key)).toEqual([
      "roleFamily", "company", "workMode", "country", "salaryVsFloor", "matchScore", "atsScore", "keywordCoverage", "postingAge",
      "resumeSent", "pitchSent", "coverLetterSent", "edited",
    ]);
  });

  it("flags a bucket whose interval clears the overall rate, in both directions", () => {
    const records = [
      ...times(10, () => record("positive", "negative", { roleFamily: { key: "analytics engineer", label: "Analytics Engineer" } })),
      ...times(20, () => record("negative", "negative")),
    ];
    const roles = dimension(computeInsights(records, { minBucket: 5 }), "roleFamily");
    expect(roles.buckets.map((b) => [b.label, b.decided, b.positives, b.standsOut])).toEqual([
      ["Data Engineer", 20, 0, "lower"],
      ["Analytics Engineer", 10, 10, "higher"],
    ]);
  });

  it("never rates or flags a bucket below the minimum", () => {
    const records = [...times(3, () => record("positive", "negative", { workMode: "hybrid" })), ...times(10, () => record("negative", "negative"))];
    const hybrid = dimension(computeInsights(records, { minBucket: 5 }), "workMode").buckets.find((b) => b.key === "hybrid")!;
    expect(hybrid).toMatchObject({ decided: 3, positives: 3, rate: null, interval: null, standsOut: null });
  });

  it("uses the fixed band order and shows only bands that have applications", () => {
    const records = [record("positive", "positive", { matchScore: 90 }), record("negative", "negative", { matchScore: 10 })];
    expect(dimension(computeInsights(records, { minBucket: 2 }), "matchScore").buckets.map((b) => b.label)).toEqual(["Under 50", "85+"]);
  });

  it("counts unknown values separately and ignores excluded applications entirely", () => {
    const records = [
      record("positive", "positive", { matchScore: null }),
      record("negative", "negative", { matchScore: null }),
      record("excluded", "excluded", { matchScore: null }),
      record("negative", "negative"),
    ];
    const match = dimension(computeInsights(records, { minBucket: 2 }), "matchScore");
    expect(match.unknownCount).toBe(2);
    expect(match.buckets).toHaveLength(1);
  });

  it("counts undecided applications in a bucket without deciding them", () => {
    const bucket = dimension(computeInsights([record("undecided", "undecided")], { minBucket: 2 }), "workMode").buckets[0];
    expect(bucket).toMatchObject({ key: "remote", decided: 0, positives: 0, undecided: 1, rate: null });
  });

  it("caps companies at 15 buckets plus an unflagged Others bucket, ordered by decided count", () => {
    const records = Array.from({ length: 17 }, (_, i) =>
      times(i === 0 ? 3 : 1, () => record("negative", "negative", { company: { key: `c${i}`, label: `Company ${i}` } }))
    ).flat();
    const company = dimension(computeInsights(records, { minBucket: 2 }), "company");
    expect(company.buckets).toHaveLength(16);
    expect(company.buckets[0]).toMatchObject({ key: "c0", decided: 3 });
    expect(company.buckets[15]).toMatchObject({ key: OTHERS_KEY, label: "Others", decided: 2, standsOut: null });
  });

  it("splits the yes/no document dimensions and treats no document data as unknown", () => {
    const records = [
      record("positive", "positive", { documents: { resume: true, pitch: true, coverLetter: false, edited: true } }),
      record("negative", "negative", { documents: { resume: false, pitch: false, coverLetter: false, edited: false } }),
      record("negative", "negative", { documents: null }),
    ];
    const insights = computeInsights(records, { minBucket: 2 });
    expect(dimension(insights, "pitchSent").buckets.map((b) => [b.label, b.decided])).toEqual([["Yes", 1], ["No", 1]]);
    expect(dimension(insights, "edited").unknownCount).toBe(1);
  });

  it("computes interview breakdowns from interview labels", () => {
    const records = [record("positive", "negative"), record("positive", "positive")];
    expect(dimension(computeInsights(records, { minBucket: 2 }), "workMode", "interview").buckets[0]).toMatchObject({ decided: 2, positives: 1 });
  });
});

describe("computeInsights rejection patterns", () => {
  it("uses the interview tier once it has a rate, else the response tier", () => {
    expect(computeInsights(times(2, () => record("positive", "undecided")), { minBucket: 2 }).patterns.tier).toBe("response");
    expect(computeInsights(times(2, () => record("positive", "negative")), { minBucket: 2 }).patterns.tier).toBe("interview");
  });

  it("lists terms missed in at least two negatives, with counts on both sides", () => {
    const records = [
      record("negative", "negative", { missedRequiredTerms: ["Tableau", "dbt"] }),
      record("negative", "negative", { missedRequiredTerms: ["tableau", "Airflow"] }),
      record("negative", "negative", { missedRequiredTerms: ["dbt", "Tableau", "TABLEAU"] }),
      record("positive", "positive", { missedRequiredTerms: ["Tableau"] }),
      record("positive", "positive", { missedRequiredTerms: [] }),
      record("negative", "negative", { missedRequiredTerms: null }),
      record("undecided", "undecided", { missedRequiredTerms: ["Tableau"] }),
    ];
    const { patterns } = computeInsights(records, { minBucket: 2 });
    expect(patterns.tier).toBe("interview");
    expect(patterns.missedTerms).toEqual([
      { term: "Tableau", missedInNegatives: 3, missedInPositives: 1, negativesWithData: 3, positivesWithData: 2 },
      { term: "dbt", missedInNegatives: 2, missedInPositives: 0, negativesWithData: 3, positivesWithData: 2 },
    ]);
  });

  it("keeps at most 20 terms", () => {
    const terms = Array.from({ length: 25 }, (_, i) => `term${String(i).padStart(2, "0")}`);
    const records = times(2, () => record("negative", "negative", { missedRequiredTerms: terms }));
    expect(computeInsights(records, { minBucket: 2 }).patterns.missedTerms).toHaveLength(20);
  });

  it("reports high-coverage results only at or above the minimum", () => {
    const high = (label: OutcomeLabel) => record(label, label, { requiredKeywordCoverage: 0.85 });
    const low = (label: OutcomeLabel) => record(label, label, { requiredKeywordCoverage: 0.4 });
    const records = [...times(5, () => high("negative")), ...times(5, () => low("positive"))];
    const { patterns } = computeInsights(records, { minBucket: 5 });
    expect(patterns.highCoverage).toMatchObject({ decided: 5, positives: 0, rate: 0, standsOut: "lower" });
    expect(computeInsights(records.slice(1), { minBucket: 5 }).patterns.highCoverage).toBeNull();
  });
});
```

Note on the headline interval values: 2 of 5 → Wilson [0.1176, 0.7693] (z = 1.96).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/insights test -- src/stats/computeInsights.test.ts`
Expected: FAIL — `Failed to resolve import "./computeInsights"`.

- [ ] **Step 3: Implement**

`packages/insights/src/stats/dimensions.ts`:
```ts
import type { OutcomeRecord } from "../types";
import {
  COVERAGE_BANDS, POSTING_AGE_BANDS, SCORE_BANDS, coverageBand, postingAgeBand, scoreBand, type BandResult,
} from "./bands";

export type DimensionKey =
  | "roleFamily" | "company" | "workMode" | "country" | "salaryVsFloor" | "matchScore" | "atsScore" | "keywordCoverage"
  | "postingAge" | "resumeSent" | "pitchSent" | "coverLetterSent" | "edited";

export interface DimensionDef {
  key: DimensionKey;
  title: string;
  /** Fixed bucket order (bands, yes/no); null = order by decided count. */
  order: readonly BandResult[] | null;
  /** Max buckets before the rest are summed into "Others"; null = no cap. */
  cap: number | null;
  /** null = this record has no value for the dimension ("unknown"). */
  bucketOf(record: OutcomeRecord): BandResult | null;
}

export const BREAKDOWN_CAP = 15;

const YES_NO: readonly BandResult[] = [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }];
const yesNo = (value: boolean): BandResult => (value ? YES_NO[0] : YES_NO[1]);
const WORK_MODE_BANDS: readonly BandResult[] = [
  { key: "remote", label: "Remote" }, { key: "hybrid", label: "Hybrid" }, { key: "onsite", label: "Onsite" },
];
const SALARY_BANDS: readonly BandResult[] = [
  { key: "below", label: "Below your floor" }, { key: "at_or_above", label: "At or above your floor" },
];
const fromOrder = (order: readonly BandResult[], key: string | null): BandResult | null =>
  key === null ? null : (order.find((b) => b.key === key) ?? null);
const documentFlag = (pick: (d: NonNullable<OutcomeRecord["documents"]>) => boolean) => (r: OutcomeRecord): BandResult | null =>
  r.documents === null ? null : yesNo(pick(r.documents));

/** Spec §5.3, in display order. */
export const DIMENSIONS: readonly DimensionDef[] = [
  { key: "roleFamily", title: "Role family", order: null, cap: null, bucketOf: (r) => r.roleFamily },
  { key: "company", title: "Company", order: null, cap: BREAKDOWN_CAP, bucketOf: (r) => r.company },
  { key: "workMode", title: "Work mode", order: WORK_MODE_BANDS, cap: null, bucketOf: (r) => fromOrder(WORK_MODE_BANDS, r.workMode) },
  {
    key: "country", title: "Country", order: null, cap: BREAKDOWN_CAP,
    bucketOf: (r) => (r.countryCode === null ? null : { key: r.countryCode, label: r.countryCode }),
  },
  {
    key: "salaryVsFloor", title: "Salary vs your floor", order: SALARY_BANDS, cap: null,
    bucketOf: (r) => fromOrder(SALARY_BANDS, r.salaryVsFloor),
  },
  { key: "matchScore", title: "Match score", order: SCORE_BANDS, cap: null, bucketOf: (r) => (r.matchScore === null ? null : scoreBand(r.matchScore)) },
  { key: "atsScore", title: "ATS score", order: SCORE_BANDS, cap: null, bucketOf: (r) => (r.atsScore === null ? null : scoreBand(r.atsScore)) },
  {
    key: "keywordCoverage", title: "Required keyword coverage", order: COVERAGE_BANDS, cap: null,
    bucketOf: (r) => (r.requiredKeywordCoverage === null ? null : coverageBand(r.requiredKeywordCoverage)),
  },
  {
    key: "postingAge", title: "Posting age when you applied", order: POSTING_AGE_BANDS, cap: null,
    bucketOf: (r) => (r.postingAgeDays === null ? null : postingAgeBand(r.postingAgeDays)),
  },
  { key: "resumeSent", title: "Optimized resume sent", order: YES_NO, cap: null, bucketOf: documentFlag((d) => d.resume) },
  { key: "pitchSent", title: "Pitch sent", order: YES_NO, cap: null, bucketOf: documentFlag((d) => d.pitch) },
  { key: "coverLetterSent", title: "Cover letter sent", order: YES_NO, cap: null, bucketOf: documentFlag((d) => d.coverLetter) },
  { key: "edited", title: "Edited by you", order: YES_NO, cap: null, bucketOf: documentFlag((d) => d.edited) },
];
```

`packages/insights/src/stats/computeInsights.ts`:
```ts
import { TIERS, type Interval, type OutcomeRecord, type Tier } from "../types";
import { standsOut, wilsonInterval } from "./wilson";
import { DIMENSIONS, type DimensionDef, type DimensionKey } from "./dimensions";

export const OTHERS_KEY = "__others__";
export const HIGH_COVERAGE_THRESHOLD = 0.8;
export const MIN_TERM_NEGATIVES = 2;
export const MAX_MISSED_TERMS = 20;

export interface Headline {
  decided: number;
  positives: number;
  negatives: number;
  undecided: number;
  excluded: number;
  rate: number | null;
  interval: Interval | null;
}

export interface Bucket {
  key: string;
  label: string;
  decided: number;
  positives: number;
  undecided: number;
  rate: number | null;
  interval: Interval | null;
  standsOut: "higher" | "lower" | null;
}

export interface Dimension {
  key: DimensionKey;
  title: string;
  buckets: Bucket[];
  /** Non-excluded applications with no value for this dimension. */
  unknownCount: number;
}

export interface MissedTermPattern {
  term: string;
  missedInNegatives: number;
  missedInPositives: number;
  negativesWithData: number;
  positivesWithData: number;
}

export interface HighCoveragePattern {
  decided: number;
  positives: number;
  rate: number;
  interval: Interval;
  standsOut: "higher" | "lower" | null;
}

export interface Patterns {
  tier: Tier;
  missedTerms: MissedTermPattern[];
  highCoverage: HighCoveragePattern | null;
}

export interface Insights {
  totals: { applications: number; external: number };
  tiers: Record<Tier, Headline>;
  breakdowns: Record<Tier, Dimension[]>;
  patterns: Patterns;
}

interface Tally {
  key: string;
  label: string;
  decided: number;
  positives: number;
  undecided: number;
  total: number;
}

function rateOf(decided: number, positives: number, minBucket: number): { rate: number | null; interval: Interval | null } {
  if (decided < minBucket) return { rate: null, interval: null };
  return { rate: positives / decided, interval: wilsonInterval(positives, decided) };
}

function headline(records: readonly OutcomeRecord[], tier: Tier, minBucket: number): Headline {
  const counts = { positive: 0, negative: 0, undecided: 0, excluded: 0 };
  for (const r of records) counts[r[tier].label] += 1;
  const decided = counts.positive + counts.negative;
  return {
    decided, positives: counts.positive, negatives: counts.negative, undecided: counts.undecided, excluded: counts.excluded,
    ...rateOf(decided, counts.positive, minBucket),
  };
}

function breakdown(def: DimensionDef, records: readonly OutcomeRecord[], tier: Tier, minBucket: number, overall: number | null): Dimension {
  const tallies = new Map<string, Tally>();
  let unknownCount = 0;
  for (const r of records) {
    const label = r[tier].label;
    if (label === "excluded") continue;
    const band = def.bucketOf(r);
    if (band === null) {
      unknownCount += 1;
      continue;
    }
    // Records arrive most recently applied first, so the first label seen is the most recent spelling.
    const tally = tallies.get(band.key) ?? { key: band.key, label: band.label, decided: 0, positives: 0, undecided: 0, total: 0 };
    tally.total += 1;
    if (label === "positive") {
      tally.decided += 1;
      tally.positives += 1;
    } else if (label === "negative") {
      tally.decided += 1;
    } else {
      tally.undecided += 1;
    }
    tallies.set(band.key, tally);
  }

  let list: Tally[] = def.order
    ? def.order.map((band) => tallies.get(band.key)).filter((t): t is Tally => t !== undefined)
    : [...tallies.values()].sort((a, b) => b.decided - a.decided || b.total - a.total || a.label.localeCompare(b.label));
  if (def.cap !== null && list.length > def.cap) {
    const others: Tally = { key: OTHERS_KEY, label: "Others", decided: 0, positives: 0, undecided: 0, total: 0 };
    for (const t of list.slice(def.cap)) {
      others.decided += t.decided;
      others.positives += t.positives;
      others.undecided += t.undecided;
      others.total += t.total;
    }
    list = [...list.slice(0, def.cap), others];
  }

  const buckets = list.map((t): Bucket => {
    const { rate, interval } = rateOf(t.decided, t.positives, minBucket);
    return {
      key: t.key, label: t.label, decided: t.decided, positives: t.positives, undecided: t.undecided, rate, interval,
      standsOut: t.key !== OTHERS_KEY && interval !== null && overall !== null ? standsOut(interval, overall) : null,
    };
  });
  return { key: def.key, title: def.title, buckets, unknownCount };
}

function patterns(records: readonly OutcomeRecord[], tiers: Record<Tier, Headline>, minBucket: number): Patterns {
  const tier: Tier = tiers.interview.rate !== null ? "interview" : "response";
  const overall = tiers[tier].rate;

  const terms = new Map<string, MissedTermPattern>();
  let negativesWithData = 0;
  let positivesWithData = 0;
  for (const r of records) {
    const label = r[tier].label;
    if ((label !== "positive" && label !== "negative") || r.missedRequiredTerms === null) continue;
    if (label === "negative") negativesWithData += 1;
    else positivesWithData += 1;
    const seen = new Set<string>();
    for (const raw of r.missedRequiredTerms) {
      const term = raw.trim();
      const key = term.toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      const entry = terms.get(key) ?? { term, missedInNegatives: 0, missedInPositives: 0, negativesWithData: 0, positivesWithData: 0 };
      if (label === "negative") entry.missedInNegatives += 1;
      else entry.missedInPositives += 1;
      terms.set(key, entry);
    }
  }
  const missedTerms = [...terms.values()]
    .map((e) => ({ ...e, negativesWithData, positivesWithData }))
    .filter((e) => e.missedInNegatives >= MIN_TERM_NEGATIVES)
    .sort((a, b) => b.missedInNegatives - a.missedInNegatives || a.term.localeCompare(b.term))
    .slice(0, MAX_MISSED_TERMS);

  let decided = 0;
  let positives = 0;
  for (const r of records) {
    const label = r[tier].label;
    if (r.requiredKeywordCoverage === null || r.requiredKeywordCoverage < HIGH_COVERAGE_THRESHOLD) continue;
    if (label === "positive") {
      decided += 1;
      positives += 1;
    } else if (label === "negative") {
      decided += 1;
    }
  }
  const highCoverage: HighCoveragePattern | null =
    decided >= minBucket
      ? (() => {
          const interval = wilsonInterval(positives, decided);
          return { decided, positives, rate: positives / decided, interval, standsOut: overall !== null ? standsOut(interval, overall) : null };
        })()
      : null;

  return { tier, missedTerms, highCoverage };
}

/** Spec §5. Pure and deterministic: the same records always give the same insights. */
export function computeInsights(records: readonly OutcomeRecord[], opts: { minBucket: number }): Insights {
  const tiers = {
    response: headline(records, "response", opts.minBucket),
    interview: headline(records, "interview", opts.minBucket),
  };
  const breakdowns = Object.fromEntries(
    TIERS.map((tier) => [tier, DIMENSIONS.map((def) => breakdown(def, records, tier, opts.minBucket, tiers[tier].rate))])
  ) as Record<Tier, Dimension[]>;
  return {
    totals: { applications: records.length, external: records.filter((r) => r.external).length },
    tiers,
    breakdowns,
    patterns: patterns(records, tiers, opts.minBucket),
  };
}
```

Add to `packages/insights/src/index.ts`:
```ts
export { DIMENSIONS, BREAKDOWN_CAP, type DimensionDef, type DimensionKey } from "./stats/dimensions";
export {
  computeInsights, OTHERS_KEY, HIGH_COVERAGE_THRESHOLD, MIN_TERM_NEGATIVES, MAX_MISSED_TERMS,
  type Headline, type Bucket, type Dimension, type MissedTermPattern, type HighCoveragePattern, type Patterns, type Insights,
} from "./stats/computeInsights";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint`
Expected: PASS; no tsc/eslint output.

- [ ] **Step 5: Commit**

```bash
git add packages/insights/src
git commit -m "feat(insights): headlines, 13 breakdowns with Wilson intervals, rejection patterns (Phase 10a)"
```

---

### Task 5: Feature snapshot v2 — record missed required terms at apply time

**Files:**
- Create: `packages/applications/src/missedTerms.ts`
- Test: `packages/applications/src/missedTerms.test.ts`
- Modify: `packages/applications/src/snapshot.ts`, `packages/applications/src/snapshot.test.ts`, `packages/applications/src/createApplication.ts`, `packages/applications/src/createApplication.test.ts`, `packages/applications/src/index.ts`, `packages/applications/package.json` (devDependency), `pnpm-lock.yaml`

**Interfaces:**
- Produces: `findMissedTerms(terms: readonly string[], text: string): string[]`, `joinOptimizedText(selectedBullets: unknown): string`; `FeatureSnapshot` (replaces `FeatureSnapshotV1`; `snapshotVersion: 2`; `ats` gains `missedRequiredTerms: string[] | null`); `BuildSnapshotInput`'s `"ingested"` variant gains `missedRequiredTerms: string[] | null`.
- Consumed later by: `packages/insights` reads `ats.missedRequiredTerms` from stored snapshots (Task 3's `parseSnapshot` already handles it).

- [ ] **Step 1: Add the parity-test devDependency**

In `packages/applications/package.json`, add to `devDependencies` (keep keys alphabetical):
```json
    "@ai-career/resume-optimization": "workspace:*",
```
Run: `pnpm install`
Expected: completes; lockfile updated.

- [ ] **Step 2: Write the failing tests**

`packages/applications/src/missedTerms.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scoreKeywordCoverage } from "@ai-career/resume-optimization";
import { findMissedTerms, joinOptimizedText } from "./missedTerms";

describe("findMissedTerms", () => {
  it("returns the terms not contained in the text, case-insensitively, in input order", () => {
    expect(findMissedTerms(["SQL", "Tableau", "python", "dbt"], "Built SQL models in Python")).toEqual(["Tableau", "dbt"]);
  });

  it("skips blank terms, de-duplicates case-insensitively and trims what it returns", () => {
    expect(findMissedTerms([" Tableau ", "", "  ", "tableau", "TABLEAU"], "nothing here")).toEqual(["Tableau"]);
  });

  it("matches plain substrings, so C++ needs no escaping", () => {
    expect(findMissedTerms(["C++", "Go"], "Wrote C++ services")).toEqual(["Go"]);
  });

  it("returns nothing when there are no terms", () => {
    expect(findMissedTerms([], "anything")).toEqual([]);
  });

  it.each([
    [["SQL", "Tableau", "Python"], "Built SQL models in Python"],
    [["Kubernetes", "Terraform"], "No infrastructure here"],
    [["Spark"], "Apache Spark pipelines"],
    [["C++", "Rust", "Go", "Java"], "C++ and Java"],
  ])("agrees with scoreKeywordCoverage on %j", (terms, text) => {
    const coverage = scoreKeywordCoverage(terms.map((termText) => ({ termText, requirementLevel: "required" as const })), text);
    expect(findMissedTerms(terms, text).length).toBe(Math.round(terms.length * (1 - coverage.requiredKeywordCoverage)));
  });
});

describe("joinOptimizedText", () => {
  it("joins each bullet's optimizedText with newlines, the text the ATS score used", () => {
    expect(joinOptimizedText([{ optimizedText: "a" }, { optimizedText: "b", sourceFactId: "x" }])).toBe("a\nb");
  });

  it("ignores malformed entries and non-arrays", () => {
    expect(joinOptimizedText([{ optimizedText: 1 }, null, "x", { optimizedText: "ok" }])).toBe("ok");
    expect(joinOptimizedText({ optimizedText: "no" })).toBe("");
    expect(joinOptimizedText(null)).toBe("");
  });
});
```

In `packages/applications/src/snapshot.test.ts`:
- In the first test's `buildFeatureSnapshot` input, add `missedRequiredTerms: ["Tableau"],` after `appliedAt: "2026-09-30",`.
- In its expected object change `snapshotVersion: 1,` to `snapshotVersion: 2,` and the `ats` line to:
```ts
      ats: { overallScore: 82, requiredKeywordCoverage: 0.9, preferredKeywordCoverage: 0.5, semanticSimilarity: null, missedRequiredTerms: ["Tableau"] },
```
- In the second test's input, add `missedRequiredTerms: null,` after `appliedAt: "2026-09-30"` (inside the object literal).
- In the external test, add `expect(s.snapshotVersion).toBe(2);`.

In `packages/applications/src/createApplication.test.ts`, add inside `describe("createApplication", ...)`, after the first test:
```ts
  it("records the required terms the sent resume missed (snapshot v2)", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const bullets = JSON.stringify([
      { sourceFactId: "f1", optimizedText: "Built SQL models in Python", changeType: "reworded", justification: "j" },
      { sourceFactId: "f2", optimizedText: "Ran Airflow DAGs", changeType: "unchanged", justification: "j" },
    ]);
    await t.adminSql`UPDATE resume_optimizations SET selected_bullets = ${bullets}::jsonb WHERE id = ${s.resumeId}`;
    // Explicit, increasing created_at values: the implementation orders requirements by (created_at, id), and rows
    // inserted with the default now() in quick succession can tie.
    const terms: [string, string][] = [["SQL", "required"], ["Tableau", "required"], ["python", "required"], ["dbt", "required"], ["Looker", "preferred"]];
    for (const [i, [term, level]] of terms.entries()) {
      await t.adminSql`
        INSERT INTO job_requirements (user_id, job_id, term_text, term_type, requirement_level, extraction_model,
                                      extraction_source_description_hash, created_at)
        VALUES (${USER}, ${s.jobId}, ${term}, 'skill', ${level}, 'm', 'dh', ${new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString()}::timestamptz)`;
    }

    const row = await createApplication(t.db, USER, { jobId: s.jobId, resumeOptimizationId: s.resumeId }, NOW);

    const snap = row.featureSnapshot as { snapshotVersion: number; ats: { missedRequiredTerms: string[] | null } };
    expect(snap.snapshotVersion).toBe(2);
    expect(snap.ats.missedRequiredTerms).toEqual(["Tableau", "dbt"]);
  });

  it("records no missed terms (unknown) when no optimized resume is linked", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const row = await createApplication(t.db, USER, { jobId: s.jobId, applicationPitchId: s.pitchId }, NOW);
    expect((row.featureSnapshot as { ats: unknown }).ats).toBeNull();
  });
```
And in the existing first test, after `expect(snap.ats).toMatchObject({ overallScore: 82, requiredKeywordCoverage: 0.9 });` add:
```ts
    expect(snap.ats.missedRequiredTerms).toEqual([]); // the seeded job has no requirement rows
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/applications test`
Expected: FAIL — `missedTerms.test.ts` cannot resolve `./missedTerms`; `snapshot.test.ts` gets `snapshotVersion: 1` and no `missedRequiredTerms`; the new `createApplication` test reads `undefined` for `missedRequiredTerms`.

- [ ] **Step 4: Implement**

`packages/applications/src/missedTerms.ts`:
```ts
/**
 * Phase 10a spec §6. The required job terms the sent resume text does not contain -- the same rule as
 * packages/resume-optimization's scoreKeywordCoverage (case-insensitive plain substring, blank terms skipped),
 * so the snapshot's missed terms agree with its keywordCoverage number. Kept here rather than imported so this
 * package stays free of resume-optimization's Anthropic dependency; missedTerms.test.ts pins the parity.
 */
export function findMissedTerms(terms: readonly string[], text: string): string[] {
  const haystack = text.toLowerCase();
  const seen = new Set<string>();
  const missed: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length === 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!haystack.includes(raw.toLowerCase())) missed.push(term);
  }
  return missed;
}

/** resume_optimizations.selected_bullets -> the text runResumeOptimization scored (each optimizedText, joined by "\n"). */
export function joinOptimizedText(selectedBullets: unknown): string {
  if (!Array.isArray(selectedBullets)) return "";
  return selectedBullets
    .map((b) => (typeof b === "object" && b !== null && typeof (b as { optimizedText?: unknown }).optimizedText === "string"
      ? (b as { optimizedText: string }).optimizedText
      : null))
    .filter((t): t is string => t !== null)
    .join("\n");
}
```

`packages/applications/src/snapshot.ts` — make these exact changes:
- Replace `export interface FeatureSnapshotV1 {` with `export interface FeatureSnapshot {`, and its `snapshotVersion: 1;` with `snapshotVersion: 2;`.
- Replace its `ats:` line with:
```ts
  ats: {
    overallScore: number; requiredKeywordCoverage: number; preferredKeywordCoverage: number; semanticSimilarity: number | null;
    /** v2 (Phase 10a): required job terms the sent resume text did not contain. null = unknown. */
    missedRequiredTerms: string[] | null;
  } | null;
```
- In `BuildSnapshotInput`'s `"ingested"` variant, after `appliedAt: string;` add:
```ts
      /** v2: required job terms the linked optimized resume missed; null when no optimization is linked. */
      missedRequiredTerms: string[] | null;
```
- Change the function signature to `export function buildFeatureSnapshot(input: BuildSnapshotInput): FeatureSnapshot {`.
- In both returned objects change `snapshotVersion: 1,` to `snapshotVersion: 2,`.
- In the ingested return, replace the `ats: ats && { ... },` block with:
```ts
    ats: ats && {
      overallScore: Number(ats.overallScore), requiredKeywordCoverage: Number(ats.requiredKeywordCoverage),
      preferredKeywordCoverage: Number(ats.preferredKeywordCoverage), semanticSimilarity: num(ats.semanticSimilarity),
      missedRequiredTerms: input.missedRequiredTerms,
    },
```
- In the doc comment above `buildFeatureSnapshot`, append: `v2 (Phase 10a) adds ats.missedRequiredTerms; v1 snapshots stay as written (write-once).`

`packages/applications/src/createApplication.ts`:
- Change the drizzle import to `import { and, asc, desc, eq, isNotNull } from "drizzle-orm";`
- Add `import { findMissedTerms, joinOptimizedText } from "./missedTerms";`
- Change the schema destructure to:
```ts
const { jobs, jobPostings, jobMatches, applications, applicationEvents, automationSessions, resumeOptimizations, jobRequirements } = schema;
```
- In the ingested branch, directly after the `const docs = await loadLinkedDocuments(...)` line, insert:
```ts
        // Phase 10a snapshot v2: which required terms the resume actually sent did not contain (spec §6).
        let missedRequiredTerms: string[] | null = null;
        if (docs.resume) {
          const [optimization] = await tx
            .select({ bullets: resumeOptimizations.selectedBullets })
            .from(resumeOptimizations)
            .where(eq(resumeOptimizations.id, docs.resume.id));
          const required = await tx
            .select({ termText: jobRequirements.termText })
            .from(jobRequirements)
            .where(and(eq(jobRequirements.jobId, jobId), eq(jobRequirements.requirementLevel, "required")))
            .orderBy(asc(jobRequirements.createdAt), asc(jobRequirements.id));
          missedRequiredTerms = findMissedTerms(required.map((r) => r.termText), joinOptimizedText(optimization?.bullets));
        }
```
- In the `buildFeatureSnapshot({ kind: "ingested", ... })` call, add `missedRequiredTerms,` after `appliedAt,`.

`packages/applications/src/index.ts`:
- Replace `type FeatureSnapshotV1` with `type FeatureSnapshot` in the snapshot export.
- Add: `export { findMissedTerms, joinOptimizedText } from "./missedTerms";`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ai-career/applications test && pnpm --filter @ai-career/applications typecheck && pnpm --filter @ai-career/applications lint`
Expected: all PASS; no tsc/eslint output.

Run: `git grep -n "FeatureSnapshotV1" -- ':!docs'`
Expected: no output (only the historical Phase 9 plan under docs/ mentions the old name).

- [ ] **Step 6: Commit**

```bash
git add packages/applications pnpm-lock.yaml
git commit -m "feat(applications): feature snapshot v2 records the required terms the sent resume missed (Phase 10a)"
```

---

### Task 6: `loadInsightInputs` — one consistent RLS read

**Files:**
- Create: `packages/insights/src/load/loadInsightInputs.ts`
- Test: `packages/insights/src/load/loadInsightInputs.test.ts`
- Modify: `packages/insights/src/index.ts`

**Interfaces:**
- Consumes: `InsightInputs` and friends (Task 1); `withUserContext`, `schema`, `DbClient` from `@ai-career/db`; test helpers `openTestDb`, `wipeUser`, `TestDb` from `@ai-career/applications/testing`.
- Produces: `loadInsightInputs(db: DbClient, userId: string): Promise<InsightInputs>`.

Test users: `USER = "00000000-0000-0000-0000-000000000a01"`, `OTHER = "00000000-0000-0000-0000-000000000a02"`.

- [ ] **Step 1: Write the failing test**

`packages/insights/src/load/loadInsightInputs.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, type TestDb } from "@ai-career/applications/testing";
import { loadInsightInputs } from "./loadInsightInputs";

const USER = "00000000-0000-0000-0000-000000000a01";
const OTHER = "00000000-0000-0000-0000-000000000a02";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
  await t.close();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
});

async function seedApplication(userId: string, notes: string): Promise<string> {
  const [row] = await t.adminSql`
    INSERT INTO applications (user_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot, notes,
                              recruiter_name, salary_notes)
    VALUES (${userId}, 'Acme', 'Data Engineer', 'screening', now(), '2026-10-01', '{"snapshotVersion":2,"external":true}'::jsonb,
            ${notes}, 'Sam Recruiter', 'asked for 90k')
    RETURNING id`;
  const id = row.id as string;
  await t.adminSql`
    INSERT INTO application_events (user_id, application_id, type, occurred_at, from_status, to_status, detail) VALUES
      (${userId}, ${id}, 'status_change', '2026-10-01T09:00:00Z', null, 'applied', '{}'::jsonb),
      (${userId}, ${id}, 'status_change', '2026-10-03T09:00:00Z', 'applied', 'screening', '{}'::jsonb),
      (${userId}, ${id}, 'note', '2026-10-04T09:00:00Z', null, null, '{"text":"private"}'::jsonb),
      (${userId}, ${id}, 'recruiter_contact', '2026-10-05T09:00:00Z', null, null, '{"channel":"email","summary":"x"}'::jsonb)`;
  return id;
}

async function seedGoal(userId: string, opts: { confirmed: boolean; roles: string[]; floor: string | null }): Promise<string> {
  const [goal] = await t.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active, confirmed_at)
    VALUES (${userId}, 'goal', ${opts.confirmed ? 1 : 2}, 'parsed', ${opts.confirmed ? "confirmed" : "draft"}, ${opts.confirmed},
            ${opts.confirmed ? "2026-09-01T00:00:00Z" : null}::timestamptz)
    RETURNING id`;
  await t.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, work_mode, salary_floor_normalized, salary_currency, salary_is_parsed)
    VALUES (${userId}, ${goal.id}, ${opts.roles}, 'any', ${opts.floor}, ${opts.floor ? "EUR" : null}, ${opts.floor !== null})`;
  return goal.id as string;
}

describe("loadInsightInputs", () => {
  it("reads the user's applications, activity events and confirmed goals -- nothing else", async () => {
    const id = await seedApplication(USER, "SECRET NOTE");
    const goalId = await seedGoal(USER, { confirmed: true, roles: ["Data Engineer"], floor: "80000" });
    await seedGoal(USER, { confirmed: false, roles: ["Draft Role"], floor: null });

    const inputs = await loadInsightInputs(t.db, USER);

    expect(inputs.applications).toEqual([{
      id, jobId: null, companyName: "Acme", jobTitle: "Data Engineer", status: "screening", appliedAt: "2026-10-01",
      createdAt: expect.any(Date), featureSnapshot: { snapshotVersion: 2, external: true },
    }]);
    expect(inputs.events.map((e) => [e.type, e.toStatus, e.occurredAt.toISOString()])).toEqual([
      ["status_change", "applied", "2026-10-01T09:00:00.000Z"],
      ["status_change", "screening", "2026-10-03T09:00:00.000Z"],
      ["recruiter_contact", null, "2026-10-05T09:00:00.000Z"],
    ]);
    expect(inputs.goals).toEqual([{
      id: goalId, confirmedAt: new Date("2026-09-01T00:00:00Z"), targetRoles: ["Data Engineer"], salaryFloorNormalized: 80000,
      salaryCurrency: "EUR", salaryIsParsed: true,
    }]);
    expect(JSON.stringify(inputs)).not.toMatch(/SECRET NOTE|Sam Recruiter|asked for 90k|private/);
  });

  it("never returns another user's rows (RLS)", async () => {
    await seedApplication(OTHER, "theirs");
    await seedGoal(OTHER, { confirmed: true, roles: ["Other Role"], floor: null });
    expect(await loadInsightInputs(t.db, USER)).toEqual({ applications: [], events: [], goals: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/insights test -- src/load/loadInsightInputs.test.ts`
Expected: FAIL — `Failed to resolve import "./loadInsightInputs"`.

- [ ] **Step 3: Implement**

`packages/insights/src/load/loadInsightInputs.ts`:
```ts
import { asc, eq, inArray } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { InsightEventType, InsightInputs } from "../types";

const { applications, applicationEvents, careerGoals, careerGoalConstraints } = schema;
const ACTIVITY_TYPES: InsightEventType[] = ["status_change", "recruiter_contact", "interview"];

/**
 * Spec §3. Everything the dataset needs, in one transaction under repeatable read so the three reads are one
 * consistent view. Selects only the columns the dataset uses: never notes, recruiter fields, salary notes,
 * the job URL or event details (spec §8).
 */
export async function loadInsightInputs(db: DbClient, userId: string): Promise<InsightInputs> {
  return withUserContext(
    db,
    userId,
    async (tx) => {
      const applicationRows = await tx
        .select({
          id: applications.id, jobId: applications.jobId, companyName: applications.companyName, jobTitle: applications.jobTitle,
          status: applications.status, appliedAt: applications.appliedAt, createdAt: applications.createdAt,
          featureSnapshot: applications.featureSnapshot,
        })
        .from(applications);
      const eventRows = await tx
        .select({
          applicationId: applicationEvents.applicationId, type: applicationEvents.type, occurredAt: applicationEvents.occurredAt,
          toStatus: applicationEvents.toStatus,
        })
        .from(applicationEvents)
        .where(inArray(applicationEvents.type, ACTIVITY_TYPES))
        .orderBy(asc(applicationEvents.occurredAt), asc(applicationEvents.createdAt));
      const goalRows = await tx
        .select({
          id: careerGoals.id, confirmedAt: careerGoals.confirmedAt, targetRoles: careerGoalConstraints.targetRoles,
          salaryFloorNormalized: careerGoalConstraints.salaryFloorNormalized, salaryCurrency: careerGoalConstraints.salaryCurrency,
          salaryIsParsed: careerGoalConstraints.salaryIsParsed,
        })
        .from(careerGoals)
        .innerJoin(careerGoalConstraints, eq(careerGoalConstraints.careerGoalId, careerGoals.id))
        .where(eq(careerGoals.confirmationStatus, "confirmed"));

      return {
        applications: applicationRows,
        events: eventRows.map((e) => ({ ...e, type: e.type as InsightEventType })),
        goals: goalRows.map((g) => ({
          ...g,
          salaryFloorNormalized: g.salaryFloorNormalized === null ? null : Number(g.salaryFloorNormalized),
        })),
      };
    },
    { isolationLevel: "repeatable read" }
  );
}
```

Add to `packages/insights/src/index.ts`:
```ts
export { loadInsightInputs } from "./load/loadInsightInputs";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-career/insights test && pnpm --filter @ai-career/insights typecheck && pnpm --filter @ai-career/insights lint`
Expected: PASS; no tsc/eslint output. (If `pnpm --filter @ai-career/insights typecheck` complains that `applicationRows` is not assignable because `featureSnapshot` is typed `unknown` — it is `jsonb`, which Drizzle types as `unknown`, so it should assign cleanly; do not cast.)

- [ ] **Step 5: Commit**

```bash
git add packages/insights/src
git commit -m "feat(insights): loadInsightInputs reads applications, activity events and goals under RLS (Phase 10a)"
```

---

### Task 7: Settings and `GET /api/insights`

**Files:**
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`, `.env.example`
- Modify: `apps/web/package.json`, `pnpm-lock.yaml`
- Create: `apps/web/src/app/api/insights/route.ts`
- Test: `apps/web/src/app/api/insights/route.test.ts`

**Interfaces:**
- Consumes: `loadInsightInputs`, `buildOutcomeDataset`, `computeInsights`, `Insights` from `@ai-career/insights`.
- Produces: env fields `OUTCOME_UNDECIDED_DAYS: number`, `INSIGHTS_MIN_BUCKET: number`; `GET /api/insights` returning `Insights & { settings: { undecidedDays: number; minBucket: number } }` (Task 8 renders exactly this).

Test users: `USER = "00000000-0000-0000-0000-000000000a03"`, `OTHER = "00000000-0000-0000-0000-000000000a04"`.

- [ ] **Step 1: Write the failing env test**

Append inside `describe("loadEnv", ...)` in `packages/config/src/env.test.ts`:
```ts
  it("defaults the Phase 10a insights settings", () => {
    const env = loadEnv(validSource);
    expect(env.OUTCOME_UNDECIDED_DAYS).toBe(30);
    expect(env.INSIGHTS_MIN_BUCKET).toBe(5);
  });

  it("parses and bounds the Phase 10a insights settings", () => {
    const env = loadEnv({ ...validSource, OUTCOME_UNDECIDED_DAYS: "45", INSIGHTS_MIN_BUCKET: "8" });
    expect(env.OUTCOME_UNDECIDED_DAYS).toBe(45);
    expect(env.INSIGHTS_MIN_BUCKET).toBe(8);
    expect(() => loadEnv({ ...validSource, OUTCOME_UNDECIDED_DAYS: "0" })).toThrow(/OUTCOME_UNDECIDED_DAYS/);
    expect(() => loadEnv({ ...validSource, INSIGHTS_MIN_BUCKET: "1" })).toThrow(/INSIGHTS_MIN_BUCKET/);
    expect(() => loadEnv({ ...validSource, INSIGHTS_MIN_BUCKET: "2.5" })).toThrow(/INSIGHTS_MIN_BUCKET/);
  });
```

Run: `pnpm --filter @ai-career/config test`
Expected: FAIL — `expected undefined to be 30`.

- [ ] **Step 2: Implement the settings**

In `packages/config/src/env.ts`, directly after the `RETENTION_DAYS` line, add:
```ts
    // Phase 10a insights. An open application with no activity for this many days counts as "no response" /
    // "no interview" (spec §4.2); a later response flips it back, since labels are computed on read.
    OUTCOME_UNDECIDED_DAYS: z.coerce.number().int().min(1).default(30),
    // Phase 10a insights. Fewer decided applications than this in a bucket shows counts only, never a rate.
    INSIGHTS_MIN_BUCKET: z.coerce.number().int().min(2).default(5),
```

In `.env.example`, after the `# RETENTION_DAYS=30` line, add:
```
# Phase 10a insights. Days without activity before an open application counts as "no response" / "no interview".
# OUTCOME_UNDECIDED_DAYS=30
# Minimum decided applications in a group before the Insights page shows a rate for it (at least 2).
# INSIGHTS_MIN_BUCKET=5
```

Run: `pnpm --filter @ai-career/config test && pnpm --filter @ai-career/config typecheck`
Expected: PASS.

- [ ] **Step 3: Add the web dependency**

In `apps/web/package.json` `dependencies`, add (alphabetical, after `"@ai-career/ingestion"`):
```json
    "@ai-career/insights": "workspace:*",
```
Run: `pnpm install`
Expected: completes; lockfile updated.

- [ ] **Step 4: Write the failing route test**

`apps/web/src/app/api/insights/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000a03",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    OUTCOME_UNDECIDED_DAYS: 30,
    INSIGHTS_MIN_BUCKET: 2,
  }),
}));

const USER = "00000000-0000-0000-0000-000000000a03";
const OTHER = "00000000-0000-0000-0000-000000000a04";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeMatchingData(admin, USER);
  await wipeMatchingData(admin, OTHER);
});
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await wipeMatchingData(admin, OTHER);
  await admin.end();
});

const { GET } = await import("./route");

const TERMINAL = new Set(["accepted", "declined", "rejected", "withdrawn", "no_response"]);

/** history: the to_status of each status_change event, oldest first; the last one is the current status. */
async function seed(userId: string, appliedDaysAgo: number, history: string[], notes = "SECRET NOTE"): Promise<void> {
  const status = history[history.length - 1];
  const [row] = await admin`
    INSERT INTO applications (user_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot, notes, terminal_at)
    VALUES (${userId}, 'Acme', 'Data Engineer', ${status}, now(), current_date - ${appliedDaysAgo}::int,
            '{"snapshotVersion":2,"external":true,"job":{},"match":null,"ats":null,"documents":null}'::jsonb, ${notes},
            ${TERMINAL.has(status) ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  for (const [i, to] of history.entries()) {
    await admin`
      INSERT INTO application_events (user_id, application_id, type, occurred_at, to_status)
      VALUES (${userId}, ${row.id}, 'status_change', (current_date - ${appliedDaysAgo}::int)::timestamptz + ${i}::int * interval '1 hour', ${to})`;
  }
}

describe("GET /api/insights", () => {
  it("returns zero counts for a user with no applications", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ undecidedDays: 30, minBucket: 2 });
    expect(body.totals).toEqual({ applications: 0, external: 0 });
    expect(body.tiers.response).toMatchObject({ decided: 0, rate: null });
    expect(body.breakdowns.response).toHaveLength(13);
  });

  it("labels the user's applications and computes both tiers, never another user's", async () => {
    await seed(USER, 5, ["applied", "screening", "rejected"]); // response yes, interview no
    await seed(USER, 5, ["applied", "screening", "interviewing"]); // both yes
    await seed(USER, 60, ["applied"]); // idle: both no
    await seed(USER, 5, ["applied", "withdrawn"]); // excluded
    await seed(OTHER, 5, ["applied", "interviewing"], "other user");

    const body = await (await GET()).json();

    expect(body.totals).toEqual({ applications: 4, external: 4 });
    expect(body.tiers.response).toMatchObject({ decided: 3, positives: 2, negatives: 1, undecided: 0, excluded: 1 });
    expect(body.tiers.response.rate).toBeCloseTo(2 / 3, 6);
    expect(body.tiers.interview).toMatchObject({ decided: 3, positives: 1, negatives: 2, excluded: 1 });
    expect(JSON.stringify(body)).not.toMatch(/SECRET NOTE|other user/);
  });
});
```

Run: `pnpm --filter web test -- src/app/api/insights/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 5: Implement the route**

`apps/web/src/app/api/insights/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { buildOutcomeDataset, computeInsights, loadInsightInputs } from "@ai-career/insights";

/**
 * Phase 10a spec §7.1. Computed on every request from the stored applications (no cache, no table): at a
 * single user's scale this is milliseconds, and it can never go stale. Aggregates only -- no notes,
 * recruiter details, URLs or application ids (spec §8).
 */
export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const inputs = await loadInsightInputs(db, env.DEFAULT_USER_ID);
    const records = buildOutcomeDataset(inputs, { now: new Date(), undecidedDays: env.OUTCOME_UNDECIDED_DAYS });
    const insights = computeInsights(records, { minBucket: env.INSIGHTS_MIN_BUCKET });
    return NextResponse.json({
      settings: { undecidedDays: env.OUTCOME_UNDECIDED_DAYS, minBucket: env.INSIGHTS_MIN_BUCKET },
      ...insights,
    });
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter web test -- src/app/api/insights/route.test.ts && pnpm --filter @ai-career/config test`
Expected: PASS.

Run: `pnpm --filter web lint`
Expected: no errors (the pre-existing `_request` warning elsewhere may remain).

- [ ] **Step 7: Commit**

```bash
git add packages/config .env.example apps/web/package.json pnpm-lock.yaml apps/web/src/app/api/insights
git commit -m "feat(web): GET /api/insights and the two insights settings (Phase 10a)"
```

---

### Task 8: The `/insights` page

**Files:**
- Create: `apps/web/src/app/insights/page.tsx`, `apps/web/src/app/insights/InsightsClient.tsx`
- Test: `apps/web/src/app/insights/InsightsClient.test.tsx`
- Modify: `apps/web/src/app/page.tsx`, `apps/web/src/app/page.test.tsx`, `apps/web/src/app/applications/page.tsx`

**Interfaces:**
- Consumes: the `GET /api/insights` JSON (Task 7); types `Insights`, `Tier`, `Headline`, `Bucket`, `Dimension`, `Patterns` from `@ai-career/insights` (type-only imports — nothing server-side is bundled into the client).
- Produces: `InsightsClient` (named export), `InsightsResponse` type.

- [ ] **Step 1: Write the failing component test**

`apps/web/src/app/insights/InsightsClient.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { InsightsClient, type InsightsResponse } from "./InsightsClient";
import type { Bucket, Dimension, Headline } from "@ai-career/insights";

beforeEach(() => vi.unstubAllGlobals());

const headline = (over: Partial<Headline>): Headline => ({
  decided: 0, positives: 0, negatives: 0, undecided: 0, excluded: 0, rate: null, interval: null, ...over,
});
const bucket = (over: Partial<Bucket>): Bucket => ({
  key: "k", label: "L", decided: 0, positives: 0, undecided: 0, rate: null, interval: null, standsOut: null, ...over,
});
const dimension = (key: Dimension["key"], title: string, buckets: Bucket[], unknownCount = 0): Dimension => ({ key, title, buckets, unknownCount });

function payload(over: Partial<InsightsResponse> = {}): InsightsResponse {
  return {
    settings: { undecidedDays: 30, minBucket: 5 },
    totals: { applications: 52, external: 2 },
    tiers: {
      response: headline({ decided: 50, positives: 11, negatives: 39, undecided: 8, excluded: 1, rate: 0.22, interval: { low: 0.1275, high: 0.3524 } }),
      interview: headline({ decided: 50, positives: 4, negatives: 46, rate: 0.08, interval: { low: 0.0315, high: 0.1884 } }),
    },
    breakdowns: {
      response: [
        dimension("roleFamily", "Role family", [
          bucket({ key: "ae", label: "Analytics Engineer", decided: 12, positives: 7, rate: 0.5833, interval: { low: 0.3196, high: 0.8067 }, standsOut: "higher" }),
          bucket({ key: "x", label: "Data Scientist", decided: 3, positives: 1 }),
        ]),
        dimension("matchScore", "Match score", [], 2),
      ],
      interview: [dimension("roleFamily", "Role family", [bucket({ key: "ae", label: "Analytics Engineer", decided: 12, positives: 2 })])],
    },
    patterns: {
      tier: "interview",
      missedTerms: [{ term: "Tableau", missedInNegatives: 4, missedInPositives: 0, negativesWithData: 20, positivesWithData: 3 }],
      highCoverage: null,
    },
    ...over,
  };
}

function mockFetch(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response)));
}

describe("InsightsClient", () => {
  it("shows each tier's rate with its sample and interval in words", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    const response = await screen.findByRole("region", { name: "Got a response" });
    expect(within(response).getByText("22% (11 of 50)")).toBeInTheDocument();
    expect(within(response).getByText("Likely between 13% and 35%.")).toBeInTheDocument();
    expect(within(response).getByText("8 still waiting · 1 withdrawn (not counted)")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Got an interview" })).getByText("8% (4 of 50)")).toBeInTheDocument();
  });

  it("shows the empty state and no rate below the minimum", async () => {
    mockFetch(payload({ tiers: { response: headline({ decided: 3, positives: 1, undecided: 2 }), interview: headline({ decided: 3 }) } }));
    render(<InsightsClient />);
    expect(await screen.findByText("Insights appear after 5 decided applications. You have 3 (2 still waiting).")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Got a response" })).getByText("1 of 3 decided. Not enough data for a rate yet."))
      .toBeInTheDocument();
  });

  it("renders breakdown tables with flags, 'Not enough data' rows, the unknown note and the caveat", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    const roles = await screen.findByRole("table", { name: "Role family" });
    expect(within(roles).getByText("Higher than your overall rate (n=12)")).toBeInTheDocument();
    expect(within(roles).getByText("58% (32–81%)")).toBeInTheDocument();
    expect(within(roles).getByText("Not enough data")).toBeInTheDocument();
    expect(screen.getByText("2 applications have no data for this.")).toBeInTheDocument();
    expect(screen.getByText("No applications in this group yet.")).toBeInTheDocument();
    expect(screen.getByText(
      "With this many comparisons, some differences appear by chance. Flags mark things worth a look, not conclusions."
    )).toBeInTheDocument();
  });

  it("switches the breakdowns between tiers", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    await screen.findByRole("table", { name: "Role family" });
    expect(screen.getByRole("button", { name: "Response" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Interview" }));
    expect(screen.getByRole("button", { name: "Interview" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Higher than your overall rate (n=12)")).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Match score" })).not.toBeInTheDocument();
  });

  it("lists recurring missed requirements and says which tier they use", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Rejection patterns" });
    expect(within(section).getByText("Based on whether you got an interview.")).toBeInTheDocument();
    expect(within(section).getByText(
      "Tableau: missed in 4 of 20 applications without an interview, and 0 of 3 with one."
    )).toBeInTheDocument();
    expect(within(section).getByText("Not enough applications with 80%+ required keyword coverage yet.")).toBeInTheDocument();
  });

  it("describes a high-coverage result when there is one", async () => {
    mockFetch(payload({
      patterns: { tier: "response", missedTerms: [], highCoverage: { decided: 10, positives: 1, rate: 0.1, interval: { low: 0.0179, high: 0.4042 }, standsOut: null } },
    }));
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Rejection patterns" });
    expect(within(section).getByText("No requirement was missed in two or more applications without a response.")).toBeInTheDocument();
    expect(within(section).getByText(
      "With 80%+ required keyword coverage: 10% (1 of 10) got a response, likely between 2% and 40%."
    )).toBeInTheDocument();
  });

  it("explains how it is calculated, using the settings", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    await screen.findByRole("table", { name: "Role family" });
    expect(screen.getByText(/after 30 days without activity/)).toBeInTheDocument();
    expect(screen.getByText(/at least 5 decided applications/)).toBeInTheDocument();
  });

  it("shows an error when loading fails", async () => {
    mockFetch({}, false);
    render(<InsightsClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load insights. Try again.");
  });
});
```

Also update the existing home-page test, which pins the exact nav links. In `apps/web/src/app/page.test.tsx`, change the `toEqual([...])` line to:
```ts
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/profile", "/career-goal", "/sources", "/jobs", "/matches", "/applications", "/insights"]);
```
and add, after the `/applications` assertion:
```ts
    expect(screen.getByRole("link", { name: /which applications get responses/i })).toHaveAttribute("href", "/insights");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test -- src/app/insights/InsightsClient.test.tsx src/app/page.test.tsx`
Expected: FAIL — `Failed to resolve import "./InsightsClient"`, and the home test's link list lacks `/insights`.

- [ ] **Step 3: Implement the page and client**

`apps/web/src/app/insights/InsightsClient.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import type { Bucket, Dimension, Headline, Insights, Patterns, Tier } from "@ai-career/insights";

export type InsightsResponse = Insights & { settings: { undecidedDays: number; minBucket: number } };
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: InsightsResponse };

const TIER_TITLE: Record<Tier, string> = { response: "Got a response", interview: "Got an interview" };
const TIER_BUTTON: Record<Tier, string> = { response: "Response", interview: "Interview" };
const TIER_NOUN: Record<Tier, string> = { response: "a response", interview: "an interview" };
const CAVEAT = "With this many comparisons, some differences appear by chance. Flags mark things worth a look, not conclusions.";
const pct = (value: number): string => `${Math.round(value * 100)}%`;

function HeadlineCard({ tier, headline }: { tier: Tier; headline: Headline }) {
  return (
    <section aria-label={TIER_TITLE[tier]} className="flex flex-col gap-1 rounded border p-4">
      <h2 className="font-medium">{TIER_TITLE[tier]}</h2>
      {headline.rate !== null && headline.interval !== null ? (
        <>
          <p className="text-2xl font-semibold">{`${pct(headline.rate)} (${headline.positives} of ${headline.decided})`}</p>
          <p className="text-sm text-gray-600">{`Likely between ${pct(headline.interval.low)} and ${pct(headline.interval.high)}.`}</p>
        </>
      ) : (
        <p className="text-sm text-gray-600">{`${headline.positives} of ${headline.decided} decided. Not enough data for a rate yet.`}</p>
      )}
      <p className="text-sm text-gray-600">{`${headline.undecided} still waiting · ${headline.excluded} withdrawn (not counted)`}</p>
    </section>
  );
}

function BucketRow({ bucket }: { bucket: Bucket }) {
  return (
    <tr className="border-t">
      <td className="py-1 pr-4">{bucket.label}</td>
      <td className="pr-4">{bucket.decided}</td>
      <td className="pr-4">{bucket.positives}</td>
      <td className="pr-4">
        {bucket.rate !== null && bucket.interval !== null ? (
          <div className="flex items-center gap-2">
            <span>{`${pct(bucket.rate)} (${Math.round(bucket.interval.low * 100)}–${pct(bucket.interval.high)})`}</span>
            <span aria-hidden="true" className="inline-block h-2 bg-gray-800" style={{ width: `${Math.round(bucket.rate * 80)}px` }} />
          </div>
        ) : (
          <span className="text-gray-500">Not enough data</span>
        )}
      </td>
      <td>
        {bucket.standsOut && (
          <span className={bucket.standsOut === "higher" ? "rounded bg-green-100 px-2 py-0.5 text-xs" : "rounded bg-red-100 px-2 py-0.5 text-xs"}>
            {`${bucket.standsOut === "higher" ? "Higher" : "Lower"} than your overall rate (n=${bucket.decided})`}
          </span>
        )}
      </td>
    </tr>
  );
}

function DimensionTable({ dimension }: { dimension: Dimension }) {
  return (
    <details open className="rounded border p-3">
      <summary className="cursor-pointer font-medium">{dimension.title}</summary>
      {dimension.buckets.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">No applications in this group yet.</p>
      ) : (
        <table aria-label={dimension.title} className="mt-2 w-full text-left text-sm">
          <thead>
            <tr>
              <th className="pr-4 font-medium">Group</th>
              <th className="pr-4 font-medium">Decided</th>
              <th className="pr-4 font-medium">Yes</th>
              <th className="pr-4 font-medium">Rate (likely range)</th>
              <th className="font-medium" />
            </tr>
          </thead>
          <tbody>
            {dimension.buckets.map((bucket) => <BucketRow key={bucket.key} bucket={bucket} />)}
          </tbody>
        </table>
      )}
      {dimension.unknownCount > 0 && (
        <p className="mt-2 text-xs text-gray-500">{`${dimension.unknownCount} applications have no data for this.`}</p>
      )}
    </details>
  );
}

function PatternsSection({ patterns }: { patterns: Patterns }) {
  const noun = TIER_NOUN[patterns.tier];
  const high = patterns.highCoverage;
  return (
    <section aria-labelledby="patterns-heading" className="flex flex-col gap-2">
      <h2 id="patterns-heading" className="text-lg font-medium">Rejection patterns</h2>
      <p className="text-sm text-gray-600">{`Based on whether you got ${noun}.`}</p>
      {patterns.missedTerms.length === 0 ? (
        <p className="text-sm">{`No requirement was missed in two or more applications without ${noun}.`}</p>
      ) : (
        <ul className="list-disc pl-5 text-sm">
          {patterns.missedTerms.map((t) => (
            <li key={t.term}>
              {`${t.term}: missed in ${t.missedInNegatives} of ${t.negativesWithData} applications without ${noun}, and ${t.missedInPositives} of ${t.positivesWithData} with one.`}
            </li>
          ))}
        </ul>
      )}
      {high ? (
        <p className="text-sm">
          {`With 80%+ required keyword coverage: ${pct(high.rate)} (${high.positives} of ${high.decided}) got ${noun}, likely between ${pct(high.interval.low)} and ${pct(high.interval.high)}${high.standsOut ? `, ${high.standsOut} than your overall rate` : ""}.`}
        </p>
      ) : (
        <p className="text-sm text-gray-600">Not enough applications with 80%+ required keyword coverage yet.</p>
      )}
    </section>
  );
}

function HowCalculated({ settings }: { settings: InsightsResponse["settings"] }) {
  return (
    <details className="rounded border p-3 text-sm">
      <summary className="cursor-pointer font-medium">How this is calculated</summary>
      <ul className="mt-2 list-disc pl-5">
        <li>An application got a response if it ever reached screening or later, or you logged a recruiter contact or an interview.</li>
        <li>It got an interview if it ever reached interviewing or later, or you logged an interview. An offer counts as both.</li>
        <li>{`An open application counts as "no" after ${settings.undecidedDays} days without activity, and turns back to "yes" if a response arrives later.`}</li>
        <li>Withdrawn applications are not counted, unless they had already got a response or interview.</li>
        <li>Role family is the career-goal target role the job title matches best; titles that match none are grouped as Other.</li>
        <li>{`A group shows a rate only with at least ${settings.minBucket} decided applications. The likely range is a 95% confidence interval.`}</li>
        {/* Worded differently from CAVEAT on purpose: the exact caveat sentence appears once, above the tables. */}
        <li>Some differences appear by chance; flags mark things worth a look, not conclusions.</li>
      </ul>
    </details>
  );
}

/** Phase 10a spec §7.2. Read-only: everything is computed by GET /api/insights. */
export function InsightsClient() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [tier, setTier] = useState<Tier>("response");

  useEffect(() => {
    let ignore = false;
    fetch("/api/insights")
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json() as Promise<InsightsResponse>;
      })
      .then((data) => {
        if (!ignore) setState({ kind: "ready", data });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, []);

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load insights. Try again.</p>;

  const { data } = state;
  const response = data.tiers.response;
  return (
    <div className="flex flex-col gap-6">
      {response.decided < data.settings.minBucket && (
        <p role="status" className="rounded border border-yellow-300 bg-yellow-50 p-3 text-sm">
          {`Insights appear after ${data.settings.minBucket} decided applications. You have ${response.decided} (${response.undecided} still waiting).`}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <HeadlineCard tier="response" headline={data.tiers.response} />
        <HeadlineCard tier="interview" headline={data.tiers.interview} />
      </div>

      <section aria-labelledby="breakdowns-heading" className="flex flex-col gap-3">
        <h2 id="breakdowns-heading" className="text-lg font-medium">Breakdowns</h2>
        <div role="group" aria-label="Outcome" className="flex gap-2">
          {(["response", "interview"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tier === t}
              onClick={() => setTier(t)}
              className={tier === t ? "rounded bg-black px-3 py-1 text-sm text-white" : "rounded border px-3 py-1 text-sm"}
            >
              {TIER_BUTTON[t]}
            </button>
          ))}
        </div>
        <p className="text-sm text-gray-600">{CAVEAT}</p>
        {data.breakdowns[tier].map((dimension) => <DimensionTable key={dimension.key} dimension={dimension} />)}
      </section>

      <PatternsSection patterns={data.patterns} />
      <HowCalculated settings={data.settings} />
    </div>
  );
}
```

Note for the implementer: the bucket cell renders `58% (32–81%)` for `rate 0.5833, interval {0.3196, 0.8067}` — the low end has no `%` sign, the high end has one (`Math.round(low*100)` then `pct(high)`), matching the test.

`apps/web/src/app/insights/page.tsx`:
```tsx
import Link from "next/link";
import { InsightsClient } from "./InsightsClient";

export default function InsightsPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
      <Link href="/" className="text-sm underline">← Home</Link>
      <h1 className="text-2xl font-semibold">Insights</h1>
      <p className="text-sm text-gray-600">What your application history says about which applications get responses and interviews.</p>
      <InsightsClient />
    </main>
  );
}
```

`apps/web/src/app/page.tsx` — after the `/applications` link, add:
```tsx
        <Link href="/insights" className="underline">
          7. Insights — see which applications get responses
        </Link>
```

`apps/web/src/app/applications/page.tsx` — replace the `<h1 ...>Applications</h1>` line with:
```tsx
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Applications</h1>
        <Link href="/insights" className="text-sm underline">Insights →</Link>
      </div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test -- src/app/insights src/app/applications src/app/page.test.tsx`
Expected: PASS (the existing applications and home tests still pass).

Run: `pnpm --filter web lint && pnpm --filter web build && pnpm --filter web typecheck`
Expected: lint 0 errors; build succeeds and lists `/insights` and `/api/insights`; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/insights apps/web/src/app/page.tsx apps/web/src/app/page.test.tsx apps/web/src/app/applications/page.tsx
git commit -m "feat(web): /insights page with tier headlines, breakdowns and rejection patterns (Phase 10a)"
```

---

### Task 9: Documentation

**Files:**
- Modify: `DECISIONS.md`, `FLOW.md`, `docs/architecture.md`, `README.md`, `docs/superpowers/specs/2026-10-06-phase-10a-outcome-analytics-design.md`

**Interfaces:**
- Consumes: everything built in Tasks 1–8 (describe only what was actually built; check each file path you cite exists).

- [ ] **Step 1: DECISIONS.md — append D140–D144 before the closing italic footer line** (`*Entries are appended chronologically...*`). Each entry follows the file's existing shape (`### Dnnn. Title`, `**Decision:**`, `**Why:**`, `**Alternatives considered:**`, `**What it affects:**`). Content:

```markdown
### D140. Phase 10 split; outcome analytics computed on read, no new tables (deviation from spec §19)
**Decision:** Phase 10 is split into 10a (outcome analytics, built here) and 10b (an interpretable baseline model and an opt-in ranking adjustment, later). 10a adds no tables: the new pure package `packages/insights` reads `applications`, their activity events and confirmed career goals in one `repeatable read` transaction (`loadInsightInputs`) and computes the dataset (`buildOutcomeDataset`) and the statistics (`computeInsights`) on every `GET /api/insights`. Spec §19's `learning_features` is the existing write-once `applications.feature_snapshot`; its `application_outcomes` is derived from status history and events, as D117 already chose.
**Why:** A single user has tens to hundreds of applications, so the computation takes milliseconds; a stored copy would add four write paths to keep in sync for no gain, and could go stale. The labels and statistics are pure functions, unit-testable without a database.
**Alternatives considered:** A materialized `learning_features` table refreshed on every status change, event and edit plus a nightly rebuild (rejected: a sync problem with no performance need). Postgres views (rejected: labels, role-family matching and intervals are awkward in SQL and would duplicate `scoreRole`). 10b may add persistence if a model needs stored, versioned feature vectors.
**What it affects:** `packages/insights` (new), `apps/web/src/app/api/insights/route.ts`, `apps/web/src/app/insights/`.

### D141. Two outcome tiers from stage history; withdrawn excluded; 30-day idle rule
**Decision:** Every application gets a label for two tiers. "Response": it ever reached screening or later (any `status_change.to_status`, or the current status), or has a `recruiter_contact`/`interview` event. "Interview": it ever reached interviewing or later, or has an `interview` event. Stages: applied 0, screening 1, interviewing 2, offer 3, accepted/declined 4 (declined = declined an offer). Evidence always wins; otherwise withdrawn is `excluded`, rejected/no_response are `negative`, and an open application with no activity for `OUTCOME_UNDECIDED_DAYS` (default 30) is `negative`, else `undecided`. Activity = applied date, status changes, recruiter contacts, interviews (not notes or follow-up actions). Each label carries a short reason string.
**Why:** The response tier has more positives, so its statistics firm up sooner; the interview tier is spec §14's target. History, not current status, is what happened: screening → rejected did get a response. Withdrawal is the user's choice, not the employer's verdict. Labels are computed on read, so a late response after day 30 flips the label back automatically.
**Alternatives considered:** Interview only (rejected: too few positives for a long time). Current status only (rejected: loses screening → rejected). A fixed `application_outcomes` row written on status change (rejected: D140).
**What it affects:** `packages/insights/src/dataset/labels.ts`, `packages/config/src/env.ts` (`OUTCOME_UNDECIDED_DAYS`).

### D142. Role family = the user's own career-goal target roles, matched deterministically
**Decision:** Each application uses the career goal its match used (`feature_snapshot.match.careerGoalId`), else the goal confirmed most recently before the application was created. Each of that goal's target roles is scored alone with `scoreRole([role], title)`; the best score wins at ≥ 0.5 (ties to the first listed role), otherwise "Other". Role keys are case- and space-insensitive across goal versions; the label is the most recent goal's spelling.
**Why:** No LLM cost or nondeterminism, no evaluation fixtures, stable groups in the user's own vocabulary, and it reuses matching's explainable word-overlap rule.
**Alternatives considered:** LLM classification into a fixed taxonomy (rejected: cost, nondeterminism, generic categories). Normalized title keys (rejected: fragments into many tiny groups, fatal at small n).
**What it affects:** `packages/insights/src/dataset/roleFamily.ts`.

### D143. Feature snapshot v2 records the required terms the sent resume missed
**Decision:** `createApplication` writes `snapshotVersion: 2`. When a resume optimization is linked, it loads the job's `required` `job_requirements` (ordered by `created_at`, `id`) and the optimization's `selected_bullets`, joins their `optimizedText` with `"\n"` (the text `runResumeOptimization` scored), and stores `ats.missedRequiredTerms` — every non-blank required term not contained in that text, case-insensitive plain substring, de-duplicated. Without a linked optimization `ats` stays `null`. The helper `findMissedTerms` lives in `packages/applications` with a parity test against `scoreKeywordCoverage`. v1 snapshots are read as "missed terms unknown".
**Why:** Spec §16's "recurring missing requirements" needs to know what was missing *when the user applied*; retention later deletes the optimization, and the profile changes over time. Recording it once in the write-once snapshot (D116) keeps it true.
**Alternatives considered:** Recomputing from current requirements and the current profile at read time (rejected: answers "what is missing now", not "what was missing then"). Importing `scoreKeywordCoverage` (rejected: pulls resume-optimization's Anthropic dependency into `packages/applications`; the parity test guards drift instead).
**What it affects:** `packages/applications/src/{missedTerms,snapshot,createApplication,index}.ts`.

### D144. Statistics: Wilson intervals, a minimum bucket, interval-clears-overall flags, careful wording
**Decision:** Rates come with 95% Wilson intervals (z = 1.96). A tier headline or bucket with fewer than `INSIGHTS_MIN_BUCKET` (default 5) decided applications shows counts only. A bucket "stands out" only when its whole interval is above or below the tier's overall rate; the company/country "Others" bucket (beyond the top 15) is never flagged. Thirteen dimensions: role family, company, work mode, country, salary vs floor, match score, ATS score, required keyword coverage, posting age, and four documents-sent flags. Unknown values are counted, not bucketed; excluded applications are left out of breakdowns. Rejection patterns use the interview tier once it has a rate, else the response tier: terms missed in ≥ 2 negatives (max 20) and the rate at ≥ 80% coverage. The UI never says "because", "causes" or "predicts", and shows a fixed chance caveat.
**Why:** Spec §14 asks for confidence and sample size rather than pretending a small personal dataset is reliable. Wilson behaves at small n and at 0%/100%. The interval rule is simple to explain; no multiple-comparison correction is applied, which the caveat states.
**Alternatives considered:** Normal-approximation intervals (rejected: nonsense at small n). A p-value or Bonferroni-corrected test (rejected: harder to explain and, at this n, flags almost nothing). Showing rates at any n (rejected: one application would show 100%).
**What it affects:** `packages/insights/src/stats/*`, `apps/web/src/app/insights/InsightsClient.tsx`, `packages/config/src/env.ts` (`INSIGHTS_MIN_BUCKET`).
```

- [ ] **Step 2: FLOW.md — append a new top-level section at the end of the file**

```markdown
## 14. Phase 10a — Outcome Analytics

### 14a. Reading insights (request-driven)

```
GET /api/insights            apps/web/src/app/api/insights/route.ts
 ├─ loadEnv(); createDbClient(env)                    (closed in finally)
 ├─ loadInsightInputs(db, DEFAULT_USER_ID)            packages/insights/src/load/loadInsightInputs.ts
 │    one withUserContext transaction, repeatable read:
 │    applications (id, job_id, company, title, status, applied_at, created_at, feature_snapshot -- no notes/recruiter/salary notes/url)
 │    application_events of type status_change | recruiter_contact | interview (no detail)
 │    confirmed career_goals ⋈ career_goal_constraints (target roles, salary floor)
 ├─ buildOutcomeDataset(inputs, { now, undecidedDays: OUTCOME_UNDECIDED_DAYS })   dataset/buildOutcomeDataset.ts
 │    per application, most recently applied first:
 │    parseSnapshot (tolerant v1/v2) → labelOutcome (two tiers, D141) → pickGoal + roleFamilyKey (D142)
 │    → salaryVsFloor → OutcomeRecord
 ├─ computeInsights(records, { minBucket: INSIGHTS_MIN_BUCKET })                   stats/computeInsights.ts
 │    headlines per tier → 13 DIMENSIONS breakdowns per tier (Wilson intervals, standsOut, Others cap)
 │    → rejection patterns (missed terms, high coverage) (D144)
 └─ 200 { settings, totals, tiers, breakdowns, patterns }
/insights  apps/web/src/app/insights/page.tsx → InsightsClient.tsx fetches GET /api/insights once; the tier toggle is client-side.
```

### 14b. Snapshot v2 write (inside the existing createApplication transaction)

`createApplication` (`packages/applications/src/createApplication.ts`), ingested branch, after `loadLinkedDocuments`:
if a resume optimization is linked → read its `selected_bullets` and the job's `required` `job_requirements`
→ `findMissedTerms(terms, joinOptimizedText(bullets))` (`missedTerms.ts`) → `buildFeatureSnapshot({ ..., missedRequiredTerms })`
writes `snapshotVersion: 2` with `ats.missedRequiredTerms` (D143). Nothing else in the Phase 9 flow (§12) changes.

### Changing Phase 10a behavior
- Labels: `packages/insights/src/dataset/labels.ts` (+ `labels.test.ts`); the cutoff is `OUTCOME_UNDECIDED_DAYS`.
- A new dimension: add a `DimensionDef` to `stats/dimensions.ts`; if it needs a new snapshot field, read it in `parseSnapshot.ts` and add it to `OutcomeRecord`.
- A new snapshot field: write it in `packages/applications/src/snapshot.ts` and bump `snapshotVersion`; `parseSnapshot` must keep reading older versions.
```

- [ ] **Step 3: docs/architecture.md — add a section after §18**

```markdown
## 19. Outcome Analytics (Phase 10a)

- **What it is.** `/insights` shows response and interview rates, overall and broken down by role family, company, work mode, country, salary vs floor, match score, ATS score, required keyword coverage, posting age and documents sent, each with its sample size and a 95% Wilson interval, plus spec §16 rejection patterns (recurring missed required terms; results at ≥ 80% keyword coverage). Deterministic: no LLM calls.
- **How.** The pure package `packages/insights` computes everything on each `GET /api/insights` from `applications.feature_snapshot`, `application_events` and confirmed career goals ([D140](../DECISIONS.md)). No new tables: spec §19's `learning_features`/`application_outcomes` are the snapshot plus derived labels.
- **Labels.** Two tiers from stage history and logged events; withdrawn is excluded; open applications count as "no" after `OUTCOME_UNDECIDED_DAYS` (default 30) without activity ([D141](../DECISIONS.md)). Role family = best-matching career-goal target role ([D142](../DECISIONS.md)).
- **Snapshot v2.** New applications record the required terms the sent resume missed ([D143](../DECISIONS.md)); v1 snapshots show those as unknown.
- **Honesty rules.** Below `INSIGHTS_MIN_BUCKET` (default 5) decided applications, counts only; "stands out" only when the interval clears the overall rate; non-causal wording and a chance caveat ([D144](../DECISIONS.md)).
- **Known gaps.** Most groups say "not enough data" until there is real history. No multiple-comparison correction. Role families split if a target role is renamed (beyond case/spacing). Missed terms use the job's requirements at apply time, which follow the current description. External applications contribute only to the overall rates, role family and company. Not built (10b): a model, predictions, any ranking change.
```

Also in §17 (Application Tracker), find the paragraph describing `feature_snapshot` and append the sentence: `Since Phase 10a the snapshot is version 2 and also records ats.missedRequiredTerms (D143).`

- [ ] **Step 4: README.md — append to the Status section, after the last phase paragraph**

```markdown
Phase 10a (Outcome Analytics) complete: `/insights` shows how often your
applications get a response and an interview, overall and by role family,
company, work mode, match score, keyword coverage, posting age and the
documents you sent — each with its sample size and a likely range, and only
once a group has enough decided applications (`INSIGHTS_MIN_BUCKET`, default
5). Applications count as "no response" after `OUTCOME_UNDECIDED_DAYS`
(default 30) without activity. No AI calls; nothing changes your rankings
yet (that is Phase 10b).
```

- [ ] **Step 5: Spec — record the as-built notes**

In `docs/superpowers/specs/2026-10-06-phase-10a-outcome-analytics-design.md`:
- In the §4.4 table's "Posting age at apply" row, change `0–2, 3–7, 8–30, 30+ days` to `0–2, 3–7, 8–30, 31+ days`.
- Append:
```markdown
## 13. Post-implementation notes

- Posting-age bands end at "31+ days" (the original "30+" overlapped "8–30").
- The UI's "How this is calculated" list words the caveat as "Some differences appear by chance; flags mark things worth a look, not conclusions." so the exact caveat sentence appears once, above the tables.
- Decisions: D140–D144 (design), D145 (verification).
```

- [ ] **Step 6: Verify every path cited in the new docs exists**

Run:
```bash
for p in packages/insights/src/load/loadInsightInputs.ts packages/insights/src/dataset/buildOutcomeDataset.ts packages/insights/src/dataset/labels.ts packages/insights/src/dataset/roleFamily.ts packages/insights/src/dataset/parseSnapshot.ts packages/insights/src/stats/computeInsights.ts packages/insights/src/stats/dimensions.ts packages/applications/src/missedTerms.ts apps/web/src/app/api/insights/route.ts apps/web/src/app/insights/InsightsClient.tsx apps/web/src/app/insights/page.tsx; do test -f "$p" || echo "MISSING $p"; done
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add DECISIONS.md FLOW.md docs/architecture.md README.md docs/superpowers/specs/2026-10-06-phase-10a-outcome-analytics-design.md
git commit -m "docs: Phase 10a decisions D140-D144, FLOW §14, architecture §19, README"
```

---

### Task 10: Verification — CI-order checks and a real-browser E2E

**Files:**
- Modify: `DECISIONS.md` (D145 — verification record)
- Scratch only (never committed): seed SQL, Playwright script, screenshots in the session scratchpad.

**Interfaces:**
- Consumes: the whole phase.

Synthetic E2E user: `00000000-0000-0000-0000-000000000a06` (`…a05` stays unused as a spare).

- [ ] **Step 1: CI-order checks from a clean state**

Run, in order, from the repo root:
```bash
pnpm install --frozen-lockfile
pnpm --filter @ai-career/db db:migrate
pnpm lint
pnpm build
pnpm typecheck
pnpm run test --force
```
Expected: every command exits 0; lint 0 errors; test summary lists `@ai-career/insights` and all other packages passing. (`pnpm test --force` does not work — pnpm parses `--force` itself; use `pnpm run test --force`.) Run the forced test command a second time; it must pass again (cross-package test-DB contention shows up as intermittent failures — if any appear, grep the whole repo for the failing test's user id before anything else).

- [ ] **Step 2: Seed the synthetic user in the test database**

Write `$SCRATCH/e2e-10a/seed.sql` (where `$SCRATCH` is the session scratchpad) and apply it with `psql postgres://career_intel:career_intel@localhost:5432/career_intel_test -f seed.sql`. It must create, for user `…000000000a06`:
1. One confirmed, active career goal (`confirmed_at` 30 days ago) with constraints `target_roles = ARRAY['Data Engineer','Analytics Engineer']`, `salary_floor_normalized = 80000`, `salary_currency = 'EUR'`, `salary_is_parsed = true`.
2. Six external applications, all with `job_title 'Data Engineer'` and `company_name 'Globex'` (snapshot `{"snapshotVersion":2,"external":true,"job":{},"match":null,"ats":null,"documents":null}`), each with matching `status_change` events, covering: screening→rejected; applied→screening→interviewing; applied→offer→declined; applied 60 days ago with no activity; applied→withdrawn; applied 3 days ago. Set `terminal_at` exactly when the status is terminal (CHECK constraint).
3. One ingested job ready to apply through the real API (copy the column lists from `seedJobWithDocuments` in `packages/applications/src/testing/db.ts`, which fills every NOT NULL column): a `jobs` row (title "Senior Data Engineer", company "Acme", `work_mode 'remote'`, `salary_max 90000`, `salary_currency 'EUR'`, `country_code 'DE'`), a `job_matches` row (eligible, `overall_score 78`, `career_goal_id` = the goal), a `resume_optimizations` v1 row whose `selected_bullets` is `[{"sourceFactId":"f1","optimizedText":"Built SQL models in Python","changeType":"reworded","justification":"j"}]`, its `ats_evaluations` row (`required_keyword_coverage 0.5`, `overall_score 70`), and `job_requirements` rows `SQL`/`Tableau` (required) and `Looker` (preferred).

- [ ] **Step 3: Run the built app against the test database as that user**

```bash
DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test \
DEFAULT_USER_ID=00000000-0000-0000-0000-000000000a06 \
INSIGHTS_MIN_BUCKET=2 \
pnpm --filter web start
```
(dotenv-cli does not override variables already set in the environment, so these win over `.env`.) Wait for `GET http://localhost:3000/api/health` → 200.

- [ ] **Step 4: Drive it with a real browser**

With `playwright-core` installed in the scratchpad (not the repo) and `executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`, script and check:
1. `POST /api/applications` with `{ jobId: <seeded job>, resumeOptimizationId: <seeded optimization> }` → 201; then read that row's `feature_snapshot` via psql: `snapshotVersion` is 2 and `ats.missedRequiredTerms` is `["Tableau"]`.
2. Open `/` → the "7. Insights" link navigates to `/insights`.
3. `/insights` shows the "Got a response" card with the expected rate for the seeded mix (compute it by hand from Step 2's list before running: the six external applications plus the new one (undecided), so response = positives {screening→rejected, interviewing, offer→declined} = 3 of decided {those 3 + the 60-day idle one} = 4 → `75% (3 of 4)`; interview = positives {interviewing, declined} = 2 of decided {those 2 + rejected + idle} = 4 → `50% (2 of 4)`); withdrawn is counted as excluded; the 3-day-old and the new application as still waiting.
4. The Role family table lists "Data Engineer"; switching to "Interview" changes the table numbers; the "How this is calculated" section expands.
5. `/applications` header link "Insights →" navigates to `/insights`.
6. Take one full-page screenshot of `/insights` into the scratchpad.
Any mismatch is a bug to fix (TDD: failing test first), not a script to adjust.

- [ ] **Step 5: Clean up**

Stop the server. Delete everything for user `…000000000a06` from `career_intel_test`: `applications`, `jobs` (cascades postings, matches, optimizations, evaluations, requirements), `job_sources` if any, `career_goals` (cascades constraints). Verify with `SELECT count(*)` on each of those tables `WHERE user_id = '…000000000a06'` → all 0.

- [ ] **Step 6: Record D145**

Append to DECISIONS.md (before the footer line):
```markdown
### D145. Phase 10a verification: CI-order checks and a real-browser E2E on a synthetic user
**Decision:** Verified with the CI order (frozen install, migrate, lint, build, typecheck, forced full test run twice) and a real-Chrome E2E against `career_intel_test` as synthetic user `…000000000a06` with `INSIGHTS_MIN_BUCKET=2`: six seeded external applications covering every label path plus one ingested application created through `POST /api/applications` (snapshot v2 recorded `["Tableau"]` as missed). `/insights` showed the hand-computed rates (response 75% of 4, interview 50% of 4), excluded/waiting counts, the role-family table, the tier toggle and both nav links. All E2E rows were deleted afterwards and counts verified 0. Scripts and screenshots stayed in the session scratchpad.
**Why:** The unit and route tests cover each rule; the E2E proves the pieces agree end to end through the real app, database and browser.
**What it affects:** No source changes.
```
Fill in the actual numbers observed; if they differ from the expected ones above, Step 4's rule applies first.

- [ ] **Step 7: Commit**

```bash
git add DECISIONS.md
git commit -m "docs: D145 Phase 10a verification"
```
