import { describe, it, expect, vi } from "vitest";
import { AiBudgetExceededError, budgetState, checkBudget, utcMonthStart, utcNextMonthStart } from "./budget";
import type { AiUsageSink } from "./types";

const sinkSpending = (spent: number): AiUsageSink & { spendSinceUsd: ReturnType<typeof vi.fn> } => ({
  spendSinceUsd: vi.fn(async () => spent),
  record: vi.fn(async () => undefined),
});

describe("UTC month bounds", () => {
  it("starts the month at 00:00 UTC on the 1st", () => {
    expect(utcMonthStart(new Date("2026-10-07T15:30:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("puts the last millisecond of a month in that month, and midnight UTC in the next", () => {
    expect(utcMonthStart(new Date("2026-10-31T23:59:59.999Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(utcMonthStart(new Date("2026-11-01T00:00:00.000Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("uses UTC even when the local date differs (late on the 31st in a UTC- zone is already next month in UTC)", () => {
    // 2026-11-01T02:00Z is still Oct 31 in New York; the ceiling resets by the UTC month.
    expect(utcMonthStart(new Date("2026-11-01T02:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("rolls December over to January of the next year", () => {
    expect(utcNextMonthStart(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(utcNextMonthStart(new Date("2026-10-07T00:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("checkBudget", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("passes under the ceiling, querying spend since the UTC month start", async () => {
    const sink = sinkSpending(19.99);
    await expect(checkBudget(sink, { AI_MONTHLY_BUDGET_USD: 20 }, now)).resolves.toBeUndefined();
    expect(sink.spendSinceUsd).toHaveBeenCalledWith(new Date("2026-10-01T00:00:00Z"));
  });

  it("blocks exactly at the ceiling", async () => {
    const error = await checkBudget(sinkSpending(20), { AI_MONTHLY_BUDGET_USD: 20 }, now).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiBudgetExceededError);
    expect(error).toMatchObject({ spentUsd: 20, ceilingUsd: 20, resetsAt: new Date("2026-11-01T00:00:00Z") });
  });

  it("blocks over the ceiling", async () => {
    await expect(checkBudget(sinkSpending(25.5), { AI_MONTHLY_BUDGET_USD: 20 }, now)).rejects.toBeInstanceOf(AiBudgetExceededError);
  });

  it("treats a 0 ceiling as unlimited and never queries spend", async () => {
    const sink = sinkSpending(1_000_000);
    await expect(checkBudget(sink, { AI_MONTHLY_BUDGET_USD: 0 }, now)).resolves.toBeUndefined();
    expect(sink.spendSinceUsd).not.toHaveBeenCalled();
  });

  it("fails closed: a spend query that throws propagates (the caller blocks the call)", async () => {
    const sink: AiUsageSink = { spendSinceUsd: async () => { throw new Error("db down"); }, record: async () => undefined };
    await expect(checkBudget(sink, { AI_MONTHLY_BUDGET_USD: 20 }, now)).rejects.toThrow("db down");
  });

  it("names itself so it survives minification-independent checks", () => {
    const error = new AiBudgetExceededError(1, 1, now);
    expect(error.name).toBe("AiBudgetExceededError");
    expect(error.message).toBe("ai_budget_exceeded");
  });
});

describe("budgetState", () => {
  it("is unlimited for a 0 ceiling", () => {
    expect(budgetState(99, { AI_MONTHLY_BUDGET_USD: 0, AI_BUDGET_WARN_PERCENT: 80 })).toBe("unlimited");
  });

  it("is ok below the warn percent, warn from it, over from the ceiling", () => {
    const env = { AI_MONTHLY_BUDGET_USD: 20, AI_BUDGET_WARN_PERCENT: 80 };
    expect(budgetState(15.99, env)).toBe("ok");
    expect(budgetState(16, env)).toBe("warn");
    expect(budgetState(19.99, env)).toBe("warn");
    expect(budgetState(20, env)).toBe("over");
    expect(budgetState(31, env)).toBe("over");
  });

  it("is over (not warn) at 100% when the warn percent is 100", () => {
    const env = { AI_MONTHLY_BUDGET_USD: 20, AI_BUDGET_WARN_PERCENT: 100 };
    expect(budgetState(19.99, env)).toBe("ok");
    expect(budgetState(20, env)).toBe("over");
  });
});
