// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { InsightsClient, type InsightsResponse } from "./InsightsClient";
import type { Bucket, Dimension, Headline } from "@ai-career/insights";

beforeEach(() => vi.unstubAllGlobals());

const headline = (over: Partial<Headline>): Headline => ({
  decided: 0, positives: 0, negatives: 0, undecided: 0, excluded: 0, rate: null, interval: null, ...over,
});
const bucket = (over: Partial<Bucket>): Bucket => ({
  key: "k", label: "L", decided: 0, positives: 0, undecided: 0, rate: null, interval: null, standsOut: null, ...over,
});
const dimension = (key: Dimension["key"], title: string, buckets: Bucket[], unknownCount = 0): Dimension => ({ key, title, buckets, unknownCount });

const MODEL_OFF: InsightsResponse["model"] = {
  status: "insufficient_data", decided: 12, responses: 3, nonResponses: 9, minDecided: 30, minPerClass: 8, blendWeight: null,
  looLogLoss: null, baselineLogLoss: null, factors: [],
};

function payload(over: Partial<InsightsResponse> = {}): InsightsResponse {
  return {
    settings: { undecidedDays: 30, minBucket: 5 },
    totals: { applications: 52, external: 2 },
    tiers: {
      response: headline({ decided: 50, positives: 11, negatives: 39, undecided: 8, excluded: 1, rate: 0.22, interval: { low: 0.1275, high: 0.3524 } }),
      interview: headline({ decided: 50, positives: 4, negatives: 46, rate: 0.08, interval: { low: 0.0315, high: 0.1884 } }),
    },
    breakdowns: {
      response: [
        dimension("roleFamily", "Role family", [
          bucket({ key: "ae", label: "Analytics Engineer", decided: 12, positives: 7, rate: 0.5833, interval: { low: 0.3196, high: 0.8067 }, standsOut: "higher" }),
          bucket({ key: "x", label: "Data Scientist", decided: 3, positives: 1 }),
        ]),
        dimension("matchScore", "Match score", [], 2),
      ],
      interview: [dimension("roleFamily", "Role family", [bucket({ key: "ae", label: "Analytics Engineer", decided: 12, positives: 2 })])],
    },
    patterns: {
      tier: "interview",
      missedTerms: [{ term: "Tableau", missedInNegatives: 4, missedInPositives: 0, negativesWithData: 20, positivesWithData: 3 }],
      highCoverage: null,
      negativesWithData: 20,
      positivesWithData: 3,
    },
    model: MODEL_OFF,
    ...over,
  };
}

function mockFetch(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response)));
}

describe("InsightsClient", () => {
  it("shows each tier's rate with its sample and interval in words", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    const response = await screen.findByRole("region", { name: "Got a response" });
    expect(within(response).getByText("22% (11 of 50)")).toBeInTheDocument();
    expect(within(response).getByText("Likely between 13% and 35%.")).toBeInTheDocument();
    expect(within(response).getByText("8 still waiting · 1 withdrawn (not counted)")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Got an interview" })).getByText("8% (4 of 50)")).toBeInTheDocument();
  });

  it("shows the empty state and no rate below the minimum", async () => {
    mockFetch(payload({ tiers: { response: headline({ decided: 3, positives: 1, undecided: 2 }), interview: headline({ decided: 3 }) } }));
    render(<InsightsClient />);
    expect(await screen.findByText("Insights appear after 5 decided applications. You have 3 (2 still waiting).")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Got a response" })).getByText("1 of 3 decided. Not enough data for a rate yet."))
      .toBeInTheDocument();
  });

  it("renders breakdown tables with flags, 'Not enough data' rows, the unknown note and the caveat", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    const roles = await screen.findByRole("table", { name: "Role family" });
    expect(within(roles).getByText("Higher than your overall rate (n=12)")).toBeInTheDocument();
    expect(within(roles).getByText("58% (32–81%)")).toBeInTheDocument();
    expect(within(roles).getByText("Not enough data")).toBeInTheDocument();
    expect(screen.getByText("2 applications have no data for this.")).toBeInTheDocument();
    expect(screen.getByText("No applications in this group yet.")).toBeInTheDocument();
    expect(screen.getByText(
      "With this many comparisons, some differences appear by chance. Flags mark things worth a look, not conclusions."
    )).toBeInTheDocument();
  });

  it("switches the breakdowns between tiers", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    await screen.findByRole("table", { name: "Role family" });
    expect(screen.getByRole("button", { name: "Response" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Interview" }));
    expect(screen.getByRole("button", { name: "Interview" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Higher than your overall rate (n=12)")).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Match score" })).not.toBeInTheDocument();
  });

  it("lists recurring missed requirements and says which tier they use", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Rejection patterns" });
    expect(within(section).getByText("Based on whether you got an interview.")).toBeInTheDocument();
    expect(within(section).getByText(
      "Tableau: missed in 4 of 20 applications without an interview, and 0 of 3 with one."
    )).toBeInTheDocument();
    expect(within(section).getByText("Not enough applications with 80%+ required keyword coverage yet.")).toBeInTheDocument();
  });

  it("describes a high-coverage result when there is one", async () => {
    mockFetch(payload({
      patterns: {
        tier: "response", missedTerms: [], negativesWithData: 12, positivesWithData: 4,
        highCoverage: { decided: 10, positives: 1, rate: 0.1, interval: { low: 0.0179, high: 0.4042 }, standsOut: null },
      },
    }));
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Rejection patterns" });
    expect(within(section).getByText("No requirement was missed in two or more applications without a response.")).toBeInTheDocument();
    expect(within(section).getByText(
      "With 80%+ required keyword coverage: 10% (1 of 10) got a response, likely between 2% and 40%."
    )).toBeInTheDocument();
  });

  it("includes the sample size in the high-coverage flag clause, matching the breakdown flag wording", async () => {
    mockFetch(payload({
      patterns: {
        tier: "response", missedTerms: [], negativesWithData: 12, positivesWithData: 4,
        highCoverage: { decided: 10, positives: 1, rate: 0.1, interval: { low: 0.0179, high: 0.4042 }, standsOut: "lower" },
      },
    }));
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Rejection patterns" });
    expect(within(section).getByText(
      "With 80%+ required keyword coverage: 10% (1 of 10) got a response, likely between 2% and 40%, lower than your overall rate (n=10)."
    )).toBeInTheDocument();
  });

  it("says missed-requirement data has not been recorded yet when there is none", async () => {
    mockFetch(payload({
      patterns: { tier: "response", missedTerms: [], negativesWithData: 0, positivesWithData: 0, highCoverage: null },
    }));
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Rejection patterns" });
    expect(within(section).getByText(
      "Missed requirements are recorded for applications sent with an optimized resume. None of your applications without a response have this data yet."
    )).toBeInTheDocument();
    expect(within(section).queryByText(/^No requirement was missed/)).not.toBeInTheDocument();
  });

  it("explains how it is calculated, using the settings", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    await screen.findByRole("table", { name: "Role family" });
    expect(screen.getByText(/after 30 days without activity/)).toBeInTheDocument();
    expect(screen.getByText(/at least 5 decided applications/)).toBeInTheDocument();
  });

  it("shows an error when loading fails", async () => {
    mockFetch({}, false);
    render(<InsightsClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load insights. Try again.");
  });

  it("shows the response model's progress toward its minimum", async () => {
    mockFetch(payload());
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Your response model" });
    expect(section).toHaveTextContent(
      "The model needs 30 decided applications with match scores, including at least 8 with a response and 8 without. You have 12 (3 with a response, 9 without)."
    );
    expect(section).toHaveTextContent("It is not a cause or a guarantee.");
  });

  it("explains an active model: the honesty check, the blend weight and each factor's direction", async () => {
    mockFetch(payload({
      model: {
        status: "active", decided: 40, responses: 20, nonResponses: 20, minDecided: 30, minPerClass: 8, blendWeight: 0.2,
        looLogLoss: 0.412, baselineLogLoss: 0.693,
        factors: [
          { key: "skillsScore", label: "Skills", direction: "higher", oddsRatio: 3.41 },
          { key: "freshnessScore", label: "Freshness", direction: "lower", oddsRatio: 1.24 },
          { key: "roleScore", label: "Role", direction: "lower", oddsRatio: 1.03 },
          { key: "experienceScore", label: "Experience", direction: "higher", oddsRatio: 1.01 },
        ],
      },
    }));
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Your response model" });
    expect(section).toHaveTextContent("Predicts responses better than your average: yes (error 0.412 vs 0.693 for your average; lower is better).");
    expect(section).toHaveTextContent('Turning on "Rank with my history" on Matches blends this model in at 20% of the ranking.');
    expect(within(section).getByText("Skills: a higher score has gone with more responses (odds ×3.4 per typical step).")).toBeInTheDocument();
    expect(within(section).getByText("Freshness: a higher score has gone with fewer responses (odds ÷1.2 per typical step).")).toBeInTheDocument();
    expect(within(section).getByText("Little or no link so far: Role, Experience.")).toBeInTheDocument();
    expect(section).not.toHaveTextContent("Role: a higher score");
  });

  it("says when the history shows no pattern", async () => {
    mockFetch(payload({ model: { ...MODEL_OFF, status: "no_pattern", decided: 40, responses: 20, nonResponses: 20, looLogLoss: 0.71, baselineLogLoss: 0.693 } }));
    render(<InsightsClient />);
    const section = await screen.findByRole("region", { name: "Your response model" });
    expect(section).toHaveTextContent("Predicts responses better than your average: no (error 0.710 vs 0.693 for your average; lower is better).");
    expect(section).toHaveTextContent("Your history doesn't show a pattern that beats your average yet, so ranking stays as it is.");
  });
});
