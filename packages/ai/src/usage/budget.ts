import type { AiUsageSink } from "./types";

/** The ceiling resets on the UTC calendar month (design §5): deterministic and testable, at most hours off local time. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function utcNextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Thrown before contacting the provider when this month's estimated spend has reached the ceiling.
 * Deliberately NOT an Anthropic.APIError, so the call sites that turn APIError into a degraded or cached
 * "failed" result (company research, match explanations) let it through -- see design §3.3.
 */
export class AiBudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly ceilingUsd: number;
  readonly resetsAt: Date;
  constructor(spentUsd: number, ceilingUsd: number, resetsAt: Date) {
    super("ai_budget_exceeded");
    this.name = "AiBudgetExceededError";
    this.spentUsd = spentUsd;
    this.ceilingUsd = ceilingUsd;
    this.resetsAt = resetsAt;
  }
}

export interface BudgetEnv {
  AI_MONTHLY_BUDGET_USD: number;
}

/**
 * Resolves when a new call may proceed. A 0 ceiling means unlimited and skips the query. A spend query
 * that throws is rethrown unchanged: the caller blocks the call (fail closed -- an unenforceable ceiling
 * must not silently become no ceiling). Check-then-call is not atomic: concurrent in-flight calls can
 * overshoot by their own cost (accepted, design §5).
 */
export async function checkBudget(sink: AiUsageSink, env: BudgetEnv, now: Date): Promise<void> {
  const ceilingUsd = env.AI_MONTHLY_BUDGET_USD;
  if (ceilingUsd === 0) return;
  const spentUsd = await sink.spendSinceUsd(utcMonthStart(now));
  if (spentUsd >= ceilingUsd) throw new AiBudgetExceededError(spentUsd, ceilingUsd, utcNextMonthStart(now));
}

export type BudgetState = "unlimited" | "ok" | "warn" | "over";

/** Compared as spent*100 vs ceiling*percent, so 16 of 20 at 80% is exactly "warn" with no float division. */
export function budgetState(spentUsd: number, env: BudgetEnv & { AI_BUDGET_WARN_PERCENT: number }): BudgetState {
  const ceilingUsd = env.AI_MONTHLY_BUDGET_USD;
  if (ceilingUsd === 0) return "unlimited";
  if (spentUsd >= ceilingUsd) return "over";
  if (spentUsd * 100 >= ceilingUsd * env.AI_BUDGET_WARN_PERCENT) return "warn";
  return "ok";
}
