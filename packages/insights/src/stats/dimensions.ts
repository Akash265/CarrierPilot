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
