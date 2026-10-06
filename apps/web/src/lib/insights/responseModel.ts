import type { DbClient } from "@ai-career/db";
import {
  buildOutcomeDataset, loadInsightInputs, summarizeModel, trainResponseModel,
  type ModelResult, type ModelSummary, type OutcomeRecord,
} from "@ai-career/insights";

/** The env fields the response model needs (Phase 10b spec §8, plus 10a's cutoff for the labels). */
export interface ResponseModelEnv {
  DEFAULT_USER_ID: string;
  OUTCOME_UNDECIDED_DAYS: number;
  OUTCOME_MODEL_MIN_DECIDED: number;
  OUTCOME_MODEL_MIN_PER_CLASS: number;
}

export interface LoadedResponseModel {
  result: ModelResult;
  summary: ModelSummary;
}

const degraded = (env: ResponseModelEnv): ModelResult => ({
  status: "no_pattern", decided: 0, responses: 0, nonResponses: 0,
  minDecided: env.OUTCOME_MODEL_MIN_DECIDED, minPerClass: env.OUTCOME_MODEL_MIN_PER_CLASS,
  looLogLoss: null, baselineLogLoss: null, blendWeight: null, model: null,
});

/**
 * Phase 10b spec §5: the model must never make a request fail. Any error while training is logged by class name
 * only (CLAUDE.md §9 -- no application content) and reported as `no_pattern`, which keeps the default ranking.
 */
export function trainResponseModelSafely(records: readonly OutcomeRecord[], env: ResponseModelEnv): LoadedResponseModel {
  let result: ModelResult;
  try {
    result = trainResponseModel(records, { minDecided: env.OUTCOME_MODEL_MIN_DECIDED, minPerClass: env.OUTCOME_MODEL_MIN_PER_CLASS });
  } catch (error) {
    console.error(JSON.stringify({ event: "response_model_failed", error: error instanceof Error ? error.name : "unknown" }));
    result = degraded(env);
  }
  return { result, summary: summarizeModel(result) };
}

/** Loads the user's outcome dataset and trains the response model, degrading to `no_pattern` on any error. */
export async function loadResponseModel(db: DbClient, env: ResponseModelEnv, now: Date = new Date()): Promise<LoadedResponseModel> {
  let records: OutcomeRecord[];
  try {
    const inputs = await loadInsightInputs(db, env.DEFAULT_USER_ID);
    records = buildOutcomeDataset(inputs, { now, undecidedDays: env.OUTCOME_UNDECIDED_DAYS });
  } catch (error) {
    console.error(JSON.stringify({ event: "response_model_failed", error: error instanceof Error ? error.name : "unknown" }));
    const result = degraded(env);
    return { result, summary: summarizeModel(result) };
  }
  return trainResponseModelSafely(records, env);
}
