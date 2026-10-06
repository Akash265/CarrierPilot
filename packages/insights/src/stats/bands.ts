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
