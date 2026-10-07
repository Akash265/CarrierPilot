import { describe, it, expect } from "vitest";
import { AiBudgetExceededError } from "@ai-career/ai";
import { budgetExceededBody, budgetExceededResponse } from "./budgetResponse";

const error = new AiBudgetExceededError(20.4567, 20, new Date("2026-11-01T00:00:00Z"));

describe("budgetExceededBody", () => {
  it("carries a readable message in `error` (what every AI panel already displays) plus a stable code and the numbers", () => {
    expect(budgetExceededBody(error)).toEqual({
      error: "Monthly AI budget reached ($20.46 of $20.00). Raise AI_MONTHLY_BUDGET_USD or wait until 2026-11-01 (UTC).",
      code: "ai_budget_exceeded",
      spentUsd: 20.4567,
      ceilingUsd: 20,
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
  });

  it("can carry extra fields a route's existing contract needs", () => {
    expect(budgetExceededBody(error, { status: "failed" })).toMatchObject({ status: "failed", code: "ai_budget_exceeded" });
  });
});

describe("budgetExceededResponse", () => {
  it("answers 429 with the body", async () => {
    const res = budgetExceededResponse(error);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(budgetExceededBody(error));
  });
});
