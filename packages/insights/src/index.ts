export * from "./types";
export { wilsonInterval, standsOut } from "./stats/wilson";
export {
  SCORE_BANDS, COVERAGE_BANDS, POSTING_AGE_BANDS, scoreBand, coverageBand, postingAgeBand, type BandResult,
} from "./stats/bands";
export { labelOutcome, type LabelInput, type LabelOptions, type LabelResult } from "./dataset/labels";
export { parseSnapshot, type ParsedSnapshot } from "./dataset/parseSnapshot";
export { OTHER_FAMILY, ROLE_MATCH_THRESHOLD, roleKey, pickGoal, roleFamilyKey, roleLabels } from "./dataset/roleFamily";
export { buildOutcomeDataset, salaryVsFloor } from "./dataset/buildOutcomeDataset";
export { DIMENSIONS, BREAKDOWN_CAP, type DimensionDef, type DimensionKey } from "./stats/dimensions";
export {
  computeInsights, OTHERS_KEY, HIGH_COVERAGE_THRESHOLD, MIN_TERM_NEGATIVES, MAX_MISSED_TERMS,
  type Headline, type Bucket, type Dimension, type MissedTermPattern, type HighCoveragePattern, type Patterns, type Insights,
} from "./stats/computeInsights";
export { loadInsightInputs } from "./load/loadInsightInputs";
export { fitLogistic, sigmoid, type LogisticFit } from "./model/fitLogistic";
export { fitScaling, standardize, type FeatureScaling } from "./model/prepareFeatures";
export {
  trainResponseModel, trainingRows, blendWeight, fitModel, modelProbability, RIDGE_LAMBDA,
  type ModelSettings, type ModelStatus, type ModelResult, type ResponseModel, type TrainingRow,
} from "./model/trainResponseModel";
export {
  predictResponse, blendedScore, describeFactors, summarizeModel, FACTOR_LABELS,
  type ResponsePrediction, type FactorEffect, type ModelSummary,
} from "./model/predictResponse";
