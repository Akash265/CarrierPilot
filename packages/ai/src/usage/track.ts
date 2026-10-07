import { randomUUID } from "node:crypto";
import { createLogger } from "@ai-career/logging";
import { AiBudgetExceededError, checkBudget, type BudgetEnv } from "./budget";
import { estimateCostUsd } from "./prices";
import { ZERO_USAGE, type AiCallEvent, type AiOperation, type AiProvider, type AiUsageSink, type UsageCounts } from "./types";

export interface TrackContext {
  sink: AiUsageSink;
  env: BudgetEnv;
  operation: AiOperation;
  provider: AiProvider;
  /** The requested model; a successful call may report the model that actually served it. */
  model: string;
  /** Epoch milliseconds; injectable for tests. */
  clock: () => number;
  /** Maps a provider failure to a short code. Never returns the error message (it can echo request content). */
  errorCodeOf: (error: unknown) => string;
}

export interface TrackedResult<T> {
  result: T;
  usage: UsageCounts;
  /**
   * False when the provider response carried no usage block. `usage` must then hold a conservative estimate from
   * the request (never zeros), so the call still counts toward the ceiling; the row says so with
   * error_code "usage_estimated".
   */
  usageReported: boolean;
  /** The model that served the call, when the response says so. */
  servedModel?: string;
}

const log = createLogger({ service: "ai" });

/** A failed `record` must never fail a call that already happened (and may have been paid for). */
async function safeRecord(sink: AiUsageSink, event: AiCallEvent): Promise<void> {
  try {
    await sink.record(event);
  } catch (error) {
    // The logger keeps the error's name, a code-like `code` (e.g. a Postgres SQLSTATE) and frames -- never its message.
    log.error("ai_usage_record_failed", { operation: event.operation, error });
  }
}

function baseEvent(ctx: TrackContext, createdAtMs: number): Omit<AiCallEvent, "outcome" | "errorCode" | "latencyMs"> {
  return {
    id: randomUUID(),
    createdAt: new Date(createdAtMs),
    operation: ctx.operation,
    provider: ctx.provider,
    model: ctx.model,
    ...ZERO_USAGE,
    estimatedCostUsd: 0,
    priceKnown: true,
  };
}

/**
 * The one tracked path (design §3): budget gate → provider call → cost estimate → one `ai_calls` row per
 * logical call (retries inside `call` are not separate rows). Blocked and failed calls are recorded and
 * the original error is rethrown unchanged, so existing error handling at call sites keeps working.
 */
export async function trackAiCall<T>(ctx: TrackContext, call: () => Promise<TrackedResult<T>>): Promise<T> {
  const startedAt = ctx.clock();
  try {
    await checkBudget(ctx.sink, ctx.env, new Date(startedAt));
  } catch (error) {
    await safeRecord(ctx.sink, {
      ...baseEvent(ctx, startedAt),
      latencyMs: 0,
      outcome: "blocked",
      errorCode: error instanceof AiBudgetExceededError ? "budget_exceeded" : "budget_check_failed",
    });
    throw error;
  }

  let tracked: TrackedResult<T>;
  try {
    tracked = await call();
  } catch (error) {
    await safeRecord(ctx.sink, {
      ...baseEvent(ctx, startedAt),
      latencyMs: Math.max(0, ctx.clock() - startedAt),
      outcome: "api_error",
      errorCode: ctx.errorCodeOf(error),
    });
    throw error;
  }

  const latencyMs = Math.max(0, ctx.clock() - startedAt);
  const model = tracked.servedModel ?? ctx.model;
  const { costUsd, priceKnown } = estimateCostUsd(ctx.provider, model, tracked.usage);
  await safeRecord(ctx.sink, {
    ...baseEvent(ctx, startedAt),
    model,
    ...tracked.usage,
    latencyMs,
    estimatedCostUsd: costUsd,
    priceKnown,
    outcome: "ok",
    errorCode: tracked.usageReported ? null : "usage_estimated",
  });
  return tracked.result;
}
