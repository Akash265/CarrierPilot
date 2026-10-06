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
