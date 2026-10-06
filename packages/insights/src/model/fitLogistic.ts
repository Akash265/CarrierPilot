import { invert, multiply } from "./linearAlgebra";

export const MAX_ITERATIONS = 50;
export const STEP_TOLERANCE = 1e-8;

export interface LogisticFit {
  intercept: number;
  /** One per column of X, in column order. */
  coefficients: number[];
  /** Inverse of the penalized Hessian at the optimum, (k+1) x (k+1), index 0 = intercept (Laplace covariance). */
  covariance: number[][];
  iterations: number;
}

/** Numerically stable logistic function. */
export function sigmoid(t: number): number {
  if (t >= 0) return 1 / (1 + Math.exp(-t));
  const e = Math.exp(t);
  return e / (1 + e);
}

/**
 * Phase 10b spec §4.2. Logistic regression with intercept and an L2 penalty `lambda` on the coefficients only
 * (not the intercept), minimizing sum(log-loss) + (lambda/2) * sum(beta^2), by Newton-Raphson from all zeros.
 * Stops when the largest absolute step is below STEP_TOLERANCE or after MAX_ITERATIONS. Deterministic: the same
 * input always gives the same output. Returns null when the Hessian cannot be inverted.
 */
export function fitLogistic(x: readonly (readonly number[])[], y: readonly number[], lambda: number): LogisticFit | null {
  const n = x.length;
  const k = n === 0 ? 0 : x[0].length;
  const params = new Array<number>(k + 1).fill(0);
  const row = (i: number): number[] => [1, ...x[i]];

  const hessianAt = (beta: readonly number[]): { gradient: number[]; hessian: number[][] } => {
    const gradient = new Array<number>(k + 1).fill(0);
    const hessian = Array.from({ length: k + 1 }, () => new Array<number>(k + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const xi = row(i);
      const p = sigmoid(xi.reduce((sum, value, j) => sum + value * beta[j], 0));
      const w = p * (1 - p);
      for (let a = 0; a <= k; a++) {
        gradient[a] += (p - y[i]) * xi[a];
        for (let b = 0; b <= k; b++) hessian[a][b] += w * xi[a] * xi[b];
      }
    }
    for (let a = 1; a <= k; a++) {
      gradient[a] += lambda * beta[a];
      hessian[a][a] += lambda;
    }
    return { gradient, hessian };
  };

  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const { gradient, hessian } = hessianAt(params);
    const inverse = invert(hessian);
    if (inverse === null) return null;
    const step = multiply(inverse, gradient);
    for (let a = 0; a <= k; a++) params[a] -= step[a];
    if (Math.max(...step.map(Math.abs)) < STEP_TOLERANCE) break;
  }
  const covariance = invert(hessianAt(params).hessian);
  if (covariance === null) return null;
  return { intercept: params[0], coefficients: params.slice(1), covariance, iterations };
}
