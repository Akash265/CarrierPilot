import { describe, it, expect } from "vitest";
import { summarizeUsage, type AiCallRow } from "./summarizeUsage";

const NOW = new Date("2026-10-07T12:00:00Z");
const ENV = { AI_MONTHLY_BUDGET_USD: 20, AI_BUDGET_WARN_PERCENT: 80 };

const row = (o: Partial<AiCallRow> = {}): AiCallRow => ({
  createdAt: new Date("2026-10-05T10:00:00Z"),
  operation: "match_explanation",
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  inputTokens: 100,
  outputTokens: 10,
  webSearchRequests: 0,
  estimatedCostUsd: 0.1,
  priceKnown: true,
  outcome: "ok",
  errorCode: null,
  ...o,
});

describe("summarizeUsage", () => {
  it("describes an empty month", () => {
    expect(summarizeUsage([], ENV, NOW)).toEqual({
      month: { start: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" },
      ceilingUsd: 20,
      warnPercent: 80,
      spentUsd: 0,
      state: "ok",
      byOperation: [],
      byModel: [],
      unknownPriceModels: [],
      usageEstimatedCalls: 0,
      recentFailures: [],
    });
  });

  it("sums spend in whole micro-dollars (no float drift) and derives the budget state", () => {
    const rows = Array.from({ length: 10 }, () => row({ estimatedCostUsd: 0.1 }));
    const summary = summarizeUsage(rows, ENV, NOW);
    expect(summary.spentUsd).toBe(1);
    expect(summary.state).toBe("ok");
    expect(summarizeUsage([row({ estimatedCostUsd: 16 })], ENV, NOW).state).toBe("warn");
    expect(summarizeUsage([row({ estimatedCostUsd: 20 })], ENV, NOW).state).toBe("over");
  });

  it("reports no ceiling as null and the state as unlimited", () => {
    const summary = summarizeUsage([row()], { ...ENV, AI_MONTHLY_BUDGET_USD: 0 }, NOW);
    expect(summary.ceilingUsd).toBeNull();
    expect(summary.state).toBe("unlimited");
  });

  it("groups by operation, counting blocked calls separately, most expensive first", () => {
    const rows = [
      row({ operation: "match_explanation", estimatedCostUsd: 0.1, inputTokens: 100, outputTokens: 10 }),
      row({ operation: "match_explanation", estimatedCostUsd: 0.2, inputTokens: 200, outputTokens: 20 }),
      row({ operation: "match_explanation", outcome: "blocked", errorCode: "budget_exceeded", estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 }),
      row({ operation: "company_research", estimatedCostUsd: 1.5, webSearchRequests: 5, model: "claude-sonnet-5" }),
      row({ operation: "job_embedding", provider: "voyage", model: "voyage-3.5", estimatedCostUsd: 0.01, outputTokens: 0, outcome: "api_error", errorCode: "voyage:503" }),
    ];
    expect(summarizeUsage(rows, ENV, NOW).byOperation).toEqual([
      { operation: "company_research", calls: 1, blocked: 0, failed: 0, inputTokens: 100, outputTokens: 10, webSearches: 5, costUsd: 1.5 },
      { operation: "match_explanation", calls: 2, blocked: 1, failed: 0, inputTokens: 300, outputTokens: 30, webSearches: 0, costUsd: 0.3 },
      { operation: "job_embedding", calls: 1, blocked: 0, failed: 1, inputTokens: 100, outputTokens: 0, webSearches: 0, costUsd: 0.01 },
    ]);
  });

  it("groups by model over calls that reached a provider (blocked calls never did)", () => {
    const rows = [
      row({ model: "claude-haiku-4-5-20251001", estimatedCostUsd: 0.1 }),
      row({ model: "claude-haiku-4-5-20251001", estimatedCostUsd: 0.1 }),
      row({ model: "claude-sonnet-5", estimatedCostUsd: 1 }),
      row({ model: "claude-sonnet-5", outcome: "blocked", estimatedCostUsd: 0 }),
    ];
    expect(summarizeUsage(rows, ENV, NOW).byModel).toEqual([
      { model: "claude-sonnet-5", calls: 1, costUsd: 1 },
      { model: "claude-haiku-4-5-20251001", calls: 2, costUsd: 0.2 },
    ]);
  });

  it("lists models priced at the conservative fallback rate, once each", () => {
    const rows = [row({ model: "claude-future-9", priceKnown: false }), row({ model: "claude-future-9", priceKnown: false }), row()];
    expect(summarizeUsage(rows, ENV, NOW).unknownPriceModels).toEqual(["claude-future-9"]);
  });

  it("counts calls whose usage was estimated, without calling their (known) model unpriced", () => {
    const rows = [row({ errorCode: "usage_estimated" }), row({ errorCode: "usage_estimated", model: "voyage-3.5" }), row()];
    const summary = summarizeUsage(rows, ENV, NOW);
    expect(summary.usageEstimatedCalls).toBe(2);
    expect(summary.unknownPriceModels).toEqual([]);
    expect(summary.recentFailures).toEqual([]);
  });

  it("returns the 20 most recent failed or blocked calls, newest first, with codes only", () => {
    const failures = Array.from({ length: 25 }, (_, i) =>
      row({ createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)), outcome: i % 2 ? "blocked" : "api_error", errorCode: `code-${i}` })
    );
    const recent = summarizeUsage([...failures, row({ createdAt: new Date("2026-10-07T11:00:00Z") })], ENV, NOW).recentFailures;
    expect(recent).toHaveLength(20);
    expect(recent[0]).toEqual({
      createdAt: "2026-10-01T00:24:00.000Z", operation: "match_explanation", model: "claude-haiku-4-5-20251001", outcome: "api_error", errorCode: "code-24",
    });
    expect(recent.at(-1)!.errorCode).toBe("code-5");
  });
});
