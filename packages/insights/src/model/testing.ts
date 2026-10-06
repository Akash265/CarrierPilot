import { FACTOR_KEYS } from "@ai-career/matching/scoring";
import type { FactorVector, OutcomeLabel, OutcomeRecord } from "../types";

/** Deterministic PRNG (mulberry32) so synthetic histories are identical on every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A factor vector with every factor drawn uniformly from [0, 1), then `over` applied. */
export function randomFactors(random: () => number, over: Partial<FactorVector> = {}): FactorVector {
  return { ...(Object.fromEntries(FACTOR_KEYS.map((k) => [k, random()])) as FactorVector), ...over };
}

let sequence = 0;
/** A minimal OutcomeRecord for model tests: only `external`, `response` and `factors` matter to the model. */
export function modelRecord(response: OutcomeLabel, factors: FactorVector | null, over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  sequence += 1;
  return {
    applicationId: `m${sequence}`, external: false, appliedAt: "2026-09-01",
    response: { label: response, reason: "" }, interview: { label: "undecided", reason: "" },
    roleFamily: { key: "__other__", label: "Other" }, company: { key: "acme", label: "Acme" }, workMode: null, countryCode: null,
    salaryVsFloor: null, matchScore: null, atsScore: null, requiredKeywordCoverage: null, postingAgeDays: null, documents: null,
    missedRequiredTerms: null, factors, ...over,
  };
}

/**
 * A synthetic history of `n` applications. Each gets random factor scores; `respond(factors, random)` decides
 * whether it got a response. Deterministic for a given seed.
 */
export function syntheticHistory(
  n: number,
  seed: number,
  respond: (factors: FactorVector, random: () => number) => boolean
): OutcomeRecord[] {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => {
    const factors = randomFactors(random);
    return modelRecord(respond(factors, random) ? "positive" : "negative", factors);
  });
}
