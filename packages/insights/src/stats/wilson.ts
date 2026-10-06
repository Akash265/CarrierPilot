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
