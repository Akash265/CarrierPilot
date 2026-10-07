import { createHash } from "node:crypto";
import { log } from "../log";
import type { DbClient } from "@ai-career/db";
import {
  buildOutcomeDataset, describeFactors, loadInsightInputs, summarizeModel, trainResponseModel, trainingRows,
  type FactorEffect, type ModelResult, type ModelSummary, type OutcomeRecord,
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

/**
 * Phase 10b final wave (DECISIONS.md D153): the last successful training result, keyed by a hash of everything that
 * determines it -- the user, the gate settings and the training rows. Labelling (including the time-dependent
 * undecided cutoff) has already been applied to the records, so equal rows mean an identical result; this lets the
 * /matches page (which re-requests every 3 s during a run) skip the O(n^2) leave-one-out refit. Single entry,
 * in-process; only successful results are stored.
 */
let cache: { key: string; result: ModelResult } | null = null;

/** Test hook: forget the cached model so each test trains from scratch. */
export function clearResponseModelCache(): void {
  cache = null;
}

function cacheKey(records: readonly OutcomeRecord[], env: ResponseModelEnv): string {
  return createHash("sha256")
    .update(JSON.stringify({
      userId: env.DEFAULT_USER_ID,
      minDecided: env.OUTCOME_MODEL_MIN_DECIDED,
      minPerClass: env.OUTCOME_MODEL_MIN_PER_CLASS,
      rows: trainingRows(records),
    }))
    .digest("hex");
}

/**
 * Phase 10b spec §5: the model must never make a request fail. The error is logged by class name and
 * stack frames only, never its message (CLAUDE.md §9 -- no application content) and reported as `no_pattern`, which keeps the default ranking.
 */
function failed(error: unknown, env: ResponseModelEnv): LoadedResponseModel {
  log.error("response_model_failed", { error });
  const result: ModelResult = {
    status: "no_pattern", decided: 0, responses: 0, nonResponses: 0,
    minDecided: env.OUTCOME_MODEL_MIN_DECIDED, minPerClass: env.OUTCOME_MODEL_MIN_PER_CLASS,
    looLogLoss: null, baselineLogLoss: null, blendWeight: null, model: null,
  };
  return { result, summary: summarizeModel(result) };
}

/** Trains (or reuses the cached result for identical training rows and settings), degrading to `no_pattern` on any error. */
export function trainResponseModelSafely(records: readonly OutcomeRecord[], env: ResponseModelEnv): LoadedResponseModel {
  try {
    const key = cacheKey(records, env);
    if (cache === null || cache.key !== key) {
      const result = trainResponseModel(records, { minDecided: env.OUTCOME_MODEL_MIN_DECIDED, minPerClass: env.OUTCOME_MODEL_MIN_PER_CLASS });
      cache = { key, result };
    }
    return { result: cache.result, summary: summarizeModel(cache.result) };
  } catch (error) {
    return failed(error, env);
  }
}

/** Loads the user's outcome dataset and trains the response model, degrading to `no_pattern` on any error. */
export async function loadResponseModel(db: DbClient, env: ResponseModelEnv, now: Date = new Date()): Promise<LoadedResponseModel> {
  let records: OutcomeRecord[];
  try {
    const inputs = await loadInsightInputs(db, env.DEFAULT_USER_ID);
    records = buildOutcomeDataset(inputs, { now, undecidedDays: env.OUTCOME_UNDECIDED_DAYS });
  } catch (error) {
    return failed(error, env);
  }
  return trainResponseModelSafely(records, env);
}

/** The "Your response model" block of GET /api/insights (Phase 10b spec §5). */
export interface ModelInsightsView extends ModelSummary {
  looLogLoss: number | null;
  baselineLogLoss: number | null;
  /** Each kept factor's direction and strength, strongest first; empty unless the model is active. */
  factors: FactorEffect[];
}

export function toModelInsightsView({ result, summary }: LoadedResponseModel): ModelInsightsView {
  return {
    ...summary,
    looLogLoss: result.looLogLoss,
    baselineLogLoss: result.baselineLogLoss,
    factors: result.model ? describeFactors(result.model) : [],
  };
}
