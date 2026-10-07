import { describe, it, expect } from "vitest";
import { estimateCostUsd, findPrice } from "./prices";
import { ZERO_USAGE } from "./types";

const usage = (u: Partial<typeof ZERO_USAGE>) => ({ ...ZERO_USAGE, ...u });

describe("findPrice", () => {
  it("matches a dated model id by its prefix", () => {
    expect(findPrice("anthropic", "claude-haiku-4-5-20251001")).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it("prefers the longest matching prefix (claude-opus-5-5 is not priced as claude-opus-5)", () => {
    expect(findPrice("anthropic", "claude-opus-5-5")).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(findPrice("anthropic", "claude-opus-5")).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 });
  });

  it("prices claude-fable-5-1 through the claude-fable-5 entry", () => {
    expect(findPrice("anthropic", "claude-fable-5-1")).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 });
  });

  it("only matches at a version boundary (claude-sonnet-50 is not claude-sonnet-5)", () => {
    expect(findPrice("anthropic", "claude-sonnet-50")).toBeNull();
    expect(findPrice("anthropic", "claude-sonnet-5")).toMatchObject({ inputPerMTok: 2 });
  });

  it("never matches across providers", () => {
    expect(findPrice("voyage", "claude-haiku-4-5")).toBeNull();
    expect(findPrice("anthropic", "voyage-3.5")).toBeNull();
  });

  it("distinguishes voyage-3.5 from voyage-3.5-lite", () => {
    expect(findPrice("voyage", "voyage-3.5")).toMatchObject({ inputPerMTok: 0.06 });
    expect(findPrice("voyage", "voyage-3.5-lite")).toMatchObject({ inputPerMTok: 0.02 });
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output tokens", () => {
    // 1,000,000 in at $1 + 200,000 out at $5 = $2
    expect(estimateCostUsd("anthropic", "claude-haiku-4-5-20251001", usage({ inputTokens: 1_000_000, outputTokens: 200_000 }))).toEqual({
      costUsd: 2,
      priceKnown: true,
    });
  });

  it("prices cache reads at 0.1x and cache writes at 1.25x the input rate", () => {
    // sonnet-5 input $2/MTok: 1M cache reads = $0.20, 1M cache writes = $2.50
    const { costUsd } = estimateCostUsd("anthropic", "claude-sonnet-5", usage({ cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }));
    expect(costUsd).toBeCloseTo(2.7, 10);
  });

  it("adds $0.01 per web search", () => {
    expect(estimateCostUsd("anthropic", "claude-sonnet-5", usage({ webSearchRequests: 5 })).costUsd).toBeCloseTo(0.05, 10);
  });

  it("prices Voyage embeddings from their token count", () => {
    expect(estimateCostUsd("voyage", "voyage-3.5", usage({ inputTokens: 500_000 })).costUsd).toBeCloseTo(0.03, 10);
  });

  it("rounds to whole micro-dollars (the numeric(12,6) column)", () => {
    // 3 tokens at $1/MTok = $0.000003 exactly; 1 token at $0.06/MTok = $0.00000006 -> rounds to 0
    expect(estimateCostUsd("anthropic", "claude-haiku-4-5", usage({ inputTokens: 3 })).costUsd).toBe(0.000003);
    expect(estimateCostUsd("voyage", "voyage-3.5", usage({ inputTokens: 1 })).costUsd).toBe(0);
    expect(Number.isInteger(Math.round(estimateCostUsd("anthropic", "claude-sonnet-5", usage({ inputTokens: 12_345, outputTokens: 678 })).costUsd * 1e6))).toBe(true);
  });

  it("prices an unknown Anthropic model at the most expensive known Anthropic rate and flags it", () => {
    expect(estimateCostUsd("anthropic", "claude-future-9", usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toEqual({
      costUsd: 60,
      priceKnown: false,
    });
  });

  it("prices an unknown Voyage model at the most expensive known Voyage rate and flags it", () => {
    expect(estimateCostUsd("voyage", "voyage-9", usage({ inputTokens: 1_000_000 }))).toEqual({ costUsd: 0.06, priceKnown: false });
  });

  it("costs nothing for zero usage", () => {
    expect(estimateCostUsd("anthropic", "claude-haiku-4-5", ZERO_USAGE)).toEqual({ costUsd: 0, priceKnown: true });
  });
});
