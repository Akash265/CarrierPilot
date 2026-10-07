import { budgetState, utcMonthStart, utcNextMonthStart, type BudgetState } from "@ai-career/ai";

/** The ai_calls columns the /usage view needs (never content -- the table has none). */
export interface AiCallRow {
  createdAt: Date;
  operation: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  webSearchRequests: number;
  estimatedCostUsd: number;
  priceKnown: boolean;
  outcome: string;
  errorCode: string | null;
}

export interface OperationUsage {
  operation: string;
  /** Calls that reached the provider (ok + failed); blocked calls are counted separately. */
  calls: number;
  blocked: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costUsd: number;
}

export interface UsageSummary {
  month: { start: string; resetsAt: string };
  /** null when AI_MONTHLY_BUDGET_USD is 0 (no ceiling). */
  ceilingUsd: number | null;
  warnPercent: number;
  spentUsd: number;
  state: BudgetState;
  byOperation: OperationUsage[];
  byModel: { model: string; calls: number; costUsd: number }[];
  unknownPriceModels: string[];
  /** Calls whose provider reported no token usage; their cost was estimated from the request (error_code usage_estimated). */
  usageEstimatedCalls: number;
  recentFailures: { createdAt: string; operation: string; model: string; outcome: string; errorCode: string | null }[];
}

const RECENT_FAILURES = 20;
const micro = (usd: number) => Math.round(usd * 1e6);
const fromMicro = (m: number) => m / 1e6;

/**
 * Phase 11a design §9. Pure: the route passes this month's rows. Sums run in whole micro-dollars (the
 * column's precision) so ten $0.10 calls are exactly $1.00. Lists sort by cost, then name, for stable output.
 */
export function summarizeUsage(
  rows: AiCallRow[],
  env: { AI_MONTHLY_BUDGET_USD: number; AI_BUDGET_WARN_PERCENT: number },
  now: Date
): UsageSummary {
  const spentMicro = rows.reduce((sum, r) => sum + micro(r.estimatedCostUsd), 0);

  const ops = new Map<string, OperationUsage & { micro: number }>();
  const models = new Map<string, { model: string; calls: number; micro: number }>();
  const unknown = new Set<string>();
  for (const r of rows) {
    const op = ops.get(r.operation) ?? {
      operation: r.operation, calls: 0, blocked: 0, failed: 0, inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, micro: 0,
    };
    if (r.outcome === "blocked") {
      op.blocked++;
    } else {
      op.calls++;
      if (r.outcome !== "ok") op.failed++;
      const m = models.get(r.model) ?? { model: r.model, calls: 0, micro: 0 };
      m.calls++;
      m.micro += micro(r.estimatedCostUsd);
      models.set(r.model, m);
      if (r.outcome === "ok" && !r.priceKnown) unknown.add(r.model);
    }
    op.inputTokens += r.inputTokens;
    op.outputTokens += r.outputTokens;
    op.webSearches += r.webSearchRequests;
    op.micro += micro(r.estimatedCostUsd);
    ops.set(r.operation, op);
  }

  const byCostThenName = <T extends { micro: number }>(name: (x: T) => string) => (a: T, b: T) =>
    b.micro - a.micro || name(a).localeCompare(name(b));

  return {
    month: { start: utcMonthStart(now).toISOString(), resetsAt: utcNextMonthStart(now).toISOString() },
    ceilingUsd: env.AI_MONTHLY_BUDGET_USD === 0 ? null : env.AI_MONTHLY_BUDGET_USD,
    warnPercent: env.AI_BUDGET_WARN_PERCENT,
    spentUsd: fromMicro(spentMicro),
    state: budgetState(fromMicro(spentMicro), env),
    byOperation: [...ops.values()]
      .sort(byCostThenName((o) => o.operation))
      .map(({ micro: m, ...o }) => ({ ...o, costUsd: fromMicro(m) })),
    byModel: [...models.values()]
      .sort(byCostThenName((x) => x.model))
      .map(({ micro: m, ...x }) => ({ ...x, costUsd: fromMicro(m) })),
    unknownPriceModels: [...unknown].sort(),
    usageEstimatedCalls: rows.filter((r) => r.outcome === "ok" && r.errorCode === "usage_estimated").length,
    recentFailures: rows
      .filter((r) => r.outcome !== "ok")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, RECENT_FAILURES)
      .map((r) => ({ createdAt: r.createdAt.toISOString(), operation: r.operation, model: r.model, outcome: r.outcome, errorCode: r.errorCode })),
  };
}
