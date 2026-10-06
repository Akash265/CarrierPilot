import { describe, it, expect } from "vitest";
import { blendedScore, describeFactors, predictResponse, summarizeModel, FACTOR_LABELS } from "./predictResponse";
import { trainResponseModel, type ResponseModel } from "./trainResponseModel";
import { randomFactors, syntheticHistory } from "./testing";
import type { FactorVector } from "../types";

const SETTINGS = { minDecided: 30, minPerClass: 8 };
const middle = (over: Partial<FactorVector> = {}): FactorVector => randomFactors(() => 0.5, over);

/** A hand-built model: two kept factors (skills, freshness), identity-ish covariance for checkable ranges. */
const MODEL: ResponseModel = {
  scaling: { keys: ["skillsScore", "freshnessScore"], means: [0.5, 0.5], sds: [0.25, 0.25] },
  intercept: 0,
  coefficients: [1, -0.5],
  covariance: [[0.04, 0, 0], [0, 0.04, 0], [0, 0, 0.04]],
};

describe("predictResponse", () => {
  it("is the logistic of the standardized linear predictor, with a 95% Laplace range around it", () => {
    const p = predictResponse(MODEL, middle({ skillsScore: 0.75 })); // z = (1, 0) -> logit 1
    expect(p.probability).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    const spread = 1.96 * Math.sqrt(0.04 + 0.04); // x = (1, 1, 0)
    expect(p.low).toBeCloseTo(1 / (1 + Math.exp(-(1 - spread))), 12);
    expect(p.high).toBeCloseTo(1 / (1 + Math.exp(-(1 + spread))), 12);
    expect(p.low).toBeLessThan(p.probability);
    expect(p.high).toBeGreaterThan(p.probability);
  });

  it("names factors beyond 0.1 logit units as raising or lowering, strongest first", () => {
    const p = predictResponse(MODEL, middle({ skillsScore: 0.75, freshnessScore: 0.75 })); // skills +1, freshness -0.5
    expect(p.raises).toEqual(["Skills"]);
    expect(p.lowers).toEqual(["Freshness"]);
    const quiet = predictResponse(MODEL, middle({ skillsScore: 0.52 })); // contribution 0.08
    expect(quiet.raises).toEqual([]);
  });

  it("names at most two factors per side", () => {
    const model: ResponseModel = {
      scaling: { keys: ["skillsScore", "roleScore", "experienceScore"], means: [0.5, 0.5, 0.5], sds: [0.25, 0.25, 0.25] },
      intercept: 0, coefficients: [1, 2, 0.5], covariance: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    };
    expect(predictResponse(model, middle({ skillsScore: 1, roleScore: 1, experienceScore: 1 })).raises).toEqual(["Role", "Skills"]);
  });

  it("treats a missing factor as the training mean (no contribution)", () => {
    const p = predictResponse(MODEL, middle({ skillsScore: null, freshnessScore: null }));
    expect(p.probability).toBeCloseTo(0.5, 12);
    expect(p.raises).toEqual([]);
    expect(p.lowers).toEqual([]);
  });

  it("gives narrower ranges with more data", () => {
    const respond = (f: FactorVector) => (f.skillsScore ?? 0) > 0.5;
    const small = trainResponseModel(syntheticHistory(40, 7, respond), SETTINGS).model!;
    const large = trainResponseModel(syntheticHistory(160, 7, respond), SETTINGS).model!;
    const at = middle({ skillsScore: 0.7 });
    const width = (m: ResponseModel) => predictResponse(m, at).high - predictResponse(m, at).low;
    expect(width(large)).toBeLessThan(width(small));
  });
});

describe("blendedScore", () => {
  it("blends the match score with 100 x probability and rounds to one decimal", () => {
    expect(blendedScore(80, 0.3, 0.15)).toBe(72.5);
    expect(blendedScore(80, 0.3, 0)).toBe(80);
    expect(blendedScore(60, 0.9, 0.5)).toBe(75);
  });
});

describe("describeFactors", () => {
  it("lists each kept factor's direction and odds ratio per standard step, strongest first", () => {
    expect(describeFactors(MODEL)).toEqual([
      { key: "skillsScore", label: "Skills", direction: "higher", oddsRatio: Math.exp(1) },
      { key: "freshnessScore", label: "Freshness", direction: "lower", oddsRatio: Math.exp(0.5) },
    ]);
  });

  it("labels every factor the way /matches does", () => {
    expect(FACTOR_LABELS.semanticScore).toBe("Fit");
    expect(Object.keys(FACTOR_LABELS)).toHaveLength(9);
  });
});

describe("summarizeModel", () => {
  it("keeps only the status fields an API response needs", () => {
    const result = trainResponseModel(syntheticHistory(10, 7, () => true), SETTINGS);
    expect(summarizeModel(result)).toEqual({
      status: "insufficient_data", decided: 10, responses: 10, nonResponses: 0, minDecided: 30, minPerClass: 8, blendWeight: null,
    });
  });
});
