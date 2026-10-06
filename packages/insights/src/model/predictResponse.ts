import type { FactorKey, FactorVector } from "../types";
import { sigmoid } from "./fitLogistic";
import { standardize } from "./prepareFeatures";
import type { ModelResult, ResponseModel } from "./trainResponseModel";

/** Spec §4.5: a factor is named as raising/lowering only beyond this many logit units. */
export const CONTRIBUTION_THRESHOLD = 0.1;
/** At most this many factors are named on each side. */
export const MAX_NAMED_FACTORS = 2;
const Z_95 = 1.96;

/** Display labels, matching the factor chips on /matches ("semantic" is shown as "Fit"). */
export const FACTOR_LABELS: Record<FactorKey, string> = {
  skillsScore: "Skills", experienceScore: "Experience", locationScore: "Location", sponsorshipScore: "Sponsorship",
  roleScore: "Role", salaryScore: "Salary", industryScore: "Industry", freshnessScore: "Freshness", semanticScore: "Fit",
};

export interface ResponsePrediction {
  probability: number;
  /** 95% range from the Laplace approximation (spec §4.5). */
  low: number;
  high: number;
  /** Display labels of the factors pushing the probability up / down for this match, strongest first. */
  raises: string[];
  lowers: string[];
}

/** Spec §4.5. Probability, its 95% range, and the factors that raise or lower it for this match. */
export function predictResponse(model: ResponseModel, factors: FactorVector): ResponsePrediction {
  const z = standardize(model.scaling, factors);
  const x = [1, ...z];
  const logit = model.intercept + z.reduce((sum, value, j) => sum + value * model.coefficients[j], 0);
  const variance = x.reduce((sum, xa, a) => sum + xa * x.reduce((inner, xb, b) => inner + model.covariance[a][b] * xb, 0), 0);
  const spread = Z_95 * Math.sqrt(Math.max(0, variance));

  const contributions = model.scaling.keys.map((key, j) => ({ label: FACTOR_LABELS[key], value: model.coefficients[j] * z[j] }));
  const named = (side: 1 | -1) =>
    contributions
      .filter((c) => side * c.value > CONTRIBUTION_THRESHOLD)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, MAX_NAMED_FACTORS)
      .map((c) => c.label);

  return {
    probability: sigmoid(logit),
    low: sigmoid(logit - spread),
    high: sigmoid(logit + spread),
    raises: named(1),
    lowers: named(-1),
  };
}

/** Spec §4.6: (1 - w) x match score + w x 100 x probability, one decimal. */
export function blendedScore(overallScore: number, probability: number, weight: number): number {
  return Math.round(((1 - weight) * overallScore + weight * 100 * probability) * 10) / 10;
}

export interface FactorEffect {
  key: FactorKey;
  label: string;
  direction: "higher" | "lower";
  /** e^|beta|: the change in response odds per one standard step of the factor. */
  oddsRatio: number;
}

/** Spec §5 (/api/insights): each kept factor's direction and strength, strongest first. */
export function describeFactors(model: ResponseModel): FactorEffect[] {
  return model.scaling.keys
    .map((key, j) => ({ key, beta: model.coefficients[j] }))
    .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta))
    .map(({ key, beta }) => ({
      key, label: FACTOR_LABELS[key], direction: beta >= 0 ? ("higher" as const) : ("lower" as const), oddsRatio: Math.exp(Math.abs(beta)),
    }));
}

/** The model status fields every API response carries (spec §5 ModelSummary). */
export interface ModelSummary {
  status: ModelResult["status"];
  decided: number;
  responses: number;
  nonResponses: number;
  minDecided: number;
  minPerClass: number;
  blendWeight: number | null;
}

export function summarizeModel(result: ModelResult): ModelSummary {
  return {
    status: result.status, decided: result.decided, responses: result.responses, nonResponses: result.nonResponses,
    minDecided: result.minDecided, minPerClass: result.minPerClass, blendWeight: result.blendWeight,
  };
}
