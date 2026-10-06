import { describe, it, expect } from "vitest";
import { fitLogistic, sigmoid } from "./fitLogistic";

// Reference values computed independently with NumPy (Newton iterations to a 1e-14 step, gradient norm ~1e-16).
const X = [[-1.5, 0.2], [-1.0, -0.4], [-0.5, 1.1], [-0.2, -1.3], [0.0, 0.5], [0.3, -0.8], [0.6, 1.4], [0.9, -0.1], [1.2, 0.7], [1.6, -1.2]];
const Y = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1];

describe("sigmoid", () => {
  it("is 0.5 at 0, symmetric, and finite at extremes", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(2) + sigmoid(-2)).toBeCloseTo(1, 15);
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
  });
});

describe("fitLogistic", () => {
  it("matches the NumPy reference with lambda = 1 (coefficients and Laplace covariance)", () => {
    const fit = fitLogistic(X, Y, 1)!;
    expect(fit.intercept).toBeCloseTo(-0.1368796219, 8);
    expect(fit.coefficients[0]).toBeCloseTo(0.8771758565, 8);
    expect(fit.coefficients[1]).toBeCloseTo(0.4672429274, 8);
    const expected = [
      [0.486734602, -0.0672103552, -0.0068261039],
      [-0.0672103552, 0.3820616252, 0.0368645628],
      [-0.0068261039, 0.0368645628, 0.3759833415],
    ];
    fit.covariance.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(expected[i][j], 8)));
  });

  it("matches the NumPy reference with almost no penalty, and the penalty shrinks the coefficients", () => {
    const loose = fitLogistic(X, Y, 1e-6)!;
    expect(loose.intercept).toBeCloseTo(-0.3007815744, 6);
    expect(loose.coefficients[0]).toBeCloseTo(1.6777005917, 6);
    expect(loose.coefficients[1]).toBeCloseTo(0.964782967, 6);
    const ridge = fitLogistic(X, Y, 1)!;
    expect(Math.abs(ridge.coefficients[0])).toBeLessThan(Math.abs(loose.coefficients[0]));
    expect(Math.abs(ridge.coefficients[1])).toBeLessThan(Math.abs(loose.coefficients[1]));
  });

  it("is deterministic: two fits are identical", () => {
    expect(fitLogistic(X, Y, 1)).toEqual(fitLogistic(X, Y, 1));
  });

  it("stays finite on perfectly separable data thanks to the penalty", () => {
    const fit = fitLogistic([[-2], [-1], [1], [2]], [0, 0, 1, 1], 1)!;
    expect(Number.isFinite(fit.coefficients[0])).toBe(true);
    expect(fit.coefficients[0]).toBeGreaterThan(0);
    expect(fit.iterations).toBeLessThan(50);
  });

  it("fits an intercept-only model when there are no feature columns", () => {
    const fit = fitLogistic([[], [], [], []], [1, 0, 1, 1], 1)!;
    expect(fit.coefficients).toEqual([]);
    expect(sigmoid(fit.intercept)).toBeCloseTo(0.75, 10);
  });
});
