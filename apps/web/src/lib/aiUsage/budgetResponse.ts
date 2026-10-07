import { NextResponse } from "next/server";
import type { AiBudgetExceededError } from "@ai-career/ai";

/**
 * Phase 11a design §3.3. Every AI action panel already shows the response's `error` string, so the
 * readable message goes there (no per-panel UI change); `code` lets anything else recognise the case.
 */
export function budgetExceededBody(error: AiBudgetExceededError, extra: Record<string, unknown> = {}) {
  const resetsOn = error.resetsAt.toISOString().slice(0, 10);
  return {
    ...extra,
    error: `Monthly AI budget reached ($${error.spentUsd.toFixed(2)} of $${error.ceilingUsd.toFixed(2)}). Raise AI_MONTHLY_BUDGET_USD or wait until ${resetsOn} (UTC).`,
    code: "ai_budget_exceeded" as const,
    spentUsd: error.spentUsd,
    ceilingUsd: error.ceilingUsd,
    resetsAt: error.resetsAt.toISOString(),
  };
}

export function budgetExceededResponse(error: AiBudgetExceededError, extra: Record<string, unknown> = {}) {
  return NextResponse.json(budgetExceededBody(error, extra), { status: 429 });
}
