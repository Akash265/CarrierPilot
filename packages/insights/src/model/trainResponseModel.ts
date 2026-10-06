import type { FactorVector, OutcomeRecord } from "../types";
import { fitLogistic, sigmoid } from "./fitLogistic";
import { fitScaling, standardize, type FeatureScaling } from "./prepareFeatures";

/** Spec §4.2: ridge strength on the standardized coefficients. */
export const RIDGE_LAMBDA = 1;
/** Spec §4.3: probabilities are clamped before log-loss so a confident miss is finite. */
export const LOG_LOSS_EPSILON = 1e-6;

export interface ModelSettings {
  /** OUTCOME_MODEL_MIN_DECIDED */
  minDecided: number;
  /** OUTCOME_MODEL_MIN_PER_CLASS */
  minPerClass: number;
}

export type ModelStatus = "insufficient_data" | "no_pattern" | "active";

export interface ResponseModel {
  scaling: FeatureScaling;
  intercept: number;
  /** Aligned with scaling.keys. */
  coefficients: number[];
  /** (k+1) x (k+1), index 0 = intercept. */
  covariance: number[][];
}

export interface ModelResult {
  status: ModelStatus;
  /** Training rows: decided response labels with eligible-match factor scores. */
  decided: number;
  responses: number;
  nonResponses: number;
  minDecided: number;
  minPerClass: number;
  /** Mean leave-one-out log-loss of the model and of the base-rate baseline; null when not evaluated. */
  looLogLoss: number | null;
  baselineLogLoss: number | null;
  /** Spec §4.4; null unless active. */
  blendWeight: number | null;
  /** Null unless active. */
  model: ResponseModel | null;
}

export interface TrainingRow {
  factors: FactorVector;
  y: 0 | 1;
}

/** Spec §3: non-external records with a decided response label and an eligible match's factor scores. */
export function trainingRows(records: readonly OutcomeRecord[]): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (const r of records) {
    if (r.external || r.factors === null) continue;
    if (r.response.label === "positive") rows.push({ factors: r.factors, y: 1 });
    else if (r.response.label === "negative") rows.push({ factors: r.factors, y: 0 });
  }
  return rows;
}

/** Spec §4.4: grows with the data, never above one half. */
export function blendWeight(decided: number): number {
  return Math.min(0.5, decided / 200);
}

/** Fit scaling + ridge logistic regression on these rows; null when no factor varies or the fit fails. */
export function fitModel(rows: readonly TrainingRow[]): ResponseModel | null {
  const scaling = fitScaling(rows.map((r) => r.factors));
  if (scaling.keys.length === 0) return null;
  const fit = fitLogistic(rows.map((r) => standardize(scaling, r.factors)), rows.map((r) => r.y), RIDGE_LAMBDA);
  if (fit === null) return null;
  return { scaling, intercept: fit.intercept, coefficients: fit.coefficients, covariance: fit.covariance };
}

/** The model's response probability for one factor vector. */
export function modelProbability(model: ResponseModel, factors: FactorVector): number {
  const z = standardize(model.scaling, factors);
  return sigmoid(model.intercept + z.reduce((sum, value, j) => sum + value * model.coefficients[j], 0));
}

function logLoss(y: 0 | 1, p: number): number {
  const q = Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

/**
 * Spec §4.3. Gates in order: enough data (and at least one varying factor); then a leave-one-out check that the model predicts held-out
 * applications better (lower mean log-loss) than simply predicting the rest's response rate; else active.
 * A fold whose fit fails predicts the baseline for its held-out row (it cannot help the model pass).
 */
export function trainResponseModel(records: readonly OutcomeRecord[], settings: ModelSettings): ModelResult {
  const rows = trainingRows(records);
  const responses = rows.filter((r) => r.y === 1).length;
  const base = {
    decided: rows.length, responses, nonResponses: rows.length - responses,
    minDecided: settings.minDecided, minPerClass: settings.minPerClass,
  };
  const insufficient: ModelResult = {
    ...base, status: "insufficient_data", looLogLoss: null, baselineLogLoss: null, blendWeight: null, model: null,
  };
  if (rows.length < settings.minDecided || responses < settings.minPerClass || base.nonResponses < settings.minPerClass) {
    return insufficient;
  }
  const model = fitModel(rows);
  if (model === null) {
    // §4.3: no factor left after dropping constants is insufficient_data; §4.2: a fit that fails anyway
    // (non-invertible Hessian -- guarded, practically unreachable at lambda 1) is no_pattern, with nothing evaluated.
    if (fitScaling(rows.map((r) => r.factors)).keys.length === 0) return insufficient;
    return { ...base, status: "no_pattern", looLogLoss: null, baselineLogLoss: null, blendWeight: null, model: null };
  }

  let modelLoss = 0;
  let baselineLoss = 0;
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.filter((_, j) => j !== i);
    const baseRate = rest.reduce((sum, r) => sum + r.y, 0) / rest.length;
    const foldModel = fitModel(rest);
    baselineLoss += logLoss(rows[i].y, baseRate);
    modelLoss += logLoss(rows[i].y, foldModel === null ? baseRate : modelProbability(foldModel, rows[i].factors));
  }
  const looLogLoss = modelLoss / rows.length;
  const baselineLogLoss = baselineLoss / rows.length;
  if (!(looLogLoss < baselineLogLoss)) {
    return { ...base, status: "no_pattern", looLogLoss, baselineLogLoss, blendWeight: null, model: null };
  }
  return { ...base, status: "active", looLogLoss, baselineLogLoss, blendWeight: blendWeight(rows.length), model };
}
