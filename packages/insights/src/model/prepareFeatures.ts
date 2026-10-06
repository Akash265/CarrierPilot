import { FACTOR_KEYS } from "@ai-career/matching/scoring";
import type { FactorKey, FactorVector } from "../types";

/** Below this standard deviation a factor is treated as constant and dropped (spec §4.1). */
export const MIN_STANDARD_DEVIATION = 1e-9;

export interface FeatureScaling {
  /** The factors kept, in FACTOR_KEYS order. */
  keys: FactorKey[];
  means: number[];
  /** Population standard deviations, aligned with `keys`. */
  sds: number[];
}

/**
 * Spec §4.1. Per factor: mean and population standard deviation over the rows with a value. A factor with fewer
 * than 2 values, or one that never varies, is dropped -- it cannot teach the model anything.
 */
export function fitScaling(rows: readonly FactorVector[]): FeatureScaling {
  const scaling: FeatureScaling = { keys: [], means: [], sds: [] };
  for (const key of FACTOR_KEYS) {
    const values = rows.map((r) => r[key]).filter((v): v is number => v !== null);
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    if (sd < MIN_STANDARD_DEVIATION) continue;
    scaling.keys.push(key);
    scaling.means.push(mean);
    scaling.sds.push(sd);
  }
  return scaling;
}

/** Standardized feature vector for the kept factors; a missing value becomes the training mean, i.e. 0. */
export function standardize(scaling: FeatureScaling, factors: FactorVector): number[] {
  return scaling.keys.map((key, j) => {
    const value = factors[key];
    return value === null ? 0 : (value - scaling.means[j]) / scaling.sds[j];
  });
}
