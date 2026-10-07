// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { UsageClient } from "./UsageClient";
import type { UsageSummary } from "../../lib/aiUsage/summarizeUsage";

beforeEach(() => vi.unstubAllGlobals());

function summary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    month: { start: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" },
    ceilingUsd: 20,
    warnPercent: 80,
    spentUsd: 3.5,
    state: "ok",
    byOperation: [
      { operation: "company_research", calls: 2, blocked: 0, failed: 0, inputTokens: 12000, outputTokens: 3000, webSearches: 8, costUsd: 3.2 },
      { operation: "match_explanation", calls: 30, blocked: 1, failed: 2, inputTokens: 1500, outputTokens: 900, webSearches: 0, costUsd: 0.3 },
    ],
    byModel: [
      { model: "claude-sonnet-5", calls: 2, costUsd: 3.2 },
      { model: "claude-haiku-4-5-20251001", calls: 30, costUsd: 0.3 },
    ],
    unknownPriceModels: [],
    recentFailures: [],
    ...over,
  };
}

function serve(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response)));
}

describe("UsageClient", () => {
  it("shows spend against the ceiling with a progress bar and the reset date", async () => {
    serve(summary());
    render(<UsageClient />);
    expect(await screen.findByText("$3.50 of $20.00 this month")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Share of monthly AI budget used" })).toHaveAttribute("aria-valuenow", "17");
    expect(screen.getByText("Resets 2026-11-01 (UTC).")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("breaks spend down by feature (readable names) and by model", async () => {
    serve(summary());
    render(<UsageClient />);
    const byFeature = await screen.findByRole("table", { name: "By feature" });
    const rows = within(byFeature).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["Company research", "2", "0", "0", "12,000", "3,000", "8", "$3.20"],
      ["Match explanations", "30", "1", "2", "1,500", "900", "0", "$0.30"],
    ]);
    const byModel = screen.getByRole("table", { name: "By model" });
    expect(within(byModel).getByText("claude-sonnet-5")).toBeInTheDocument();
  });

  it("warns past the warn percent", async () => {
    serve(summary({ spentUsd: 16.5, state: "warn" }));
    render(<UsageClient />);
    expect(await screen.findByText("Over 80% of your monthly AI budget.")).toBeInTheDocument();
  });

  it("says new calls are blocked once the ceiling is reached, and caps the bar at 100", async () => {
    serve(summary({ spentUsd: 21, state: "over" }));
    render(<UsageClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Monthly AI budget reached. New AI calls are blocked until 2026-11-01 (UTC) or until AI_MONTHLY_BUDGET_USD is raised."
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("shows spend without a bar when there is no ceiling", async () => {
    serve(summary({ ceilingUsd: null, state: "unlimited" }));
    render(<UsageClient />);
    expect(await screen.findByText("$3.50 this month · no monthly ceiling")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("names models priced at the fallback rate", async () => {
    serve(summary({ unknownPriceModels: ["claude-future-9"] }));
    render(<UsageClient />);
    expect(
      await screen.findByText("No price is configured for claude-future-9; its cost is estimated at the most expensive known rate.")
    ).toBeInTheDocument();
  });

  it("lists recent failed and blocked calls with their codes", async () => {
    serve(
      summary({
        recentFailures: [
          { createdAt: "2026-10-07T09:15:00.000Z", operation: "pitch_generation", model: "claude-haiku-4-5-20251001", outcome: "blocked", errorCode: "budget_exceeded" },
          { createdAt: "2026-10-06T08:00:00.000Z", operation: "job_embedding", model: "voyage-3.5", outcome: "api_error", errorCode: "voyage:503" },
        ],
      })
    );
    render(<UsageClient />);
    const table = await screen.findByRole("table", { name: "Recent failed and blocked calls" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["2026-10-07 09:15", "Hiring manager pitch", "claude-haiku-4-5-20251001", "Blocked", "budget_exceeded"],
      ["2026-10-06 08:00", "Job embeddings", "voyage-3.5", "Failed", "voyage:503"],
    ]);
  });

  it("says when there have been no calls, and always labels costs as estimates", async () => {
    serve(summary({ spentUsd: 0, byOperation: [], byModel: [] }));
    render(<UsageClient />);
    expect(await screen.findByText("No AI calls yet this month.")).toBeInTheDocument();
    expect(screen.getByText("Costs are estimates from a built-in price table, not your Anthropic or Voyage invoice.")).toBeInTheDocument();
  });

  it("shows an error when the summary cannot be loaded", async () => {
    serve({}, false);
    render(<UsageClient />);
    expect(await screen.findByText("Could not load AI usage.")).toBeInTheDocument();
  });
});
