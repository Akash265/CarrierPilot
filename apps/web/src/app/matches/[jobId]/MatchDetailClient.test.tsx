// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchDetailClient } from "./MatchDetailClient";

const job = { id: "j1", title: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote", descriptionText: "We use SQL." };
const match = {
  matchId: "m1", eligible: true, ineligibleReason: null, overallScore: 82,
  factors: { skills: 80, experience: 100, location: 100, sponsorship: 100, role: 90, salary: null, industry: 100, freshness: 100, semantic: 70 },
  explanation: { strongMatches: ["Strong SQL alignment"], partialMatches: ["Slightly under target salary"], gaps: ["Tableau requested, not found"], summary: "A strong overall match." },
  userAction: "none", computedAt: "2026-09-22T00:00:00Z",
};

function mockFetch(matchBody: unknown, matchStatus = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/resume-optimizations/")) {
        return { ok: true, status: 200, json: async () => ({ optimizations: [] }) } as Response;
      }
      if (url.includes("/api/application-pitches/")) {
        return { ok: true, status: 200, json: async () => ({ versions: [], research: null }) } as Response;
      }
      if (url.includes("/api/cover-letters/")) {
        return { ok: true, status: 200, json: async () => ({ versions: [], research: null }) } as Response;
      }
      if (url.includes("/api/interview-preps/")) {
        return { ok: true, status: 200, json: async () => ({ versions: [], research: null }) } as Response;
      }
      if (url.includes("/api/applications/for-job/")) {
        return { ok: true, status: 200, json: async () => ({ application: null, documentOptions: { resumes: [], pitches: [], coverLetters: [] } }) } as Response;
      }
      if (url.includes("/api/documents")) {
        return { ok: true, status: 200, json: async () => ({ documents: [] }) } as Response;
      }
      if (url.includes("/api/automation-sessions")) {
        return { ok: true, status: 200, json: async () => ({ support: { supported: false, reason: "no_supported_posting" }, resumeAvailable: false, applicationId: null, sessions: [] }) } as Response;
      }
      return { ok: matchStatus < 400, status: matchStatus, json: async () => matchBody } as Response;
    })
  );
}
beforeEach(() => vi.unstubAllGlobals());

describe("MatchDetailClient", () => {
  it("shows the personal response prediction and the factors behind it when present", async () => {
    mockFetch({
      job, applicationId: null,
      match: { ...match, personal: { probability: 0.62, low: 0.41, high: 0.79, raises: ["Skills", "Role"], lowers: ["Freshness"] } },
    });
    render(<MatchDetailClient jobId="j1" />);
    const section = await screen.findByRole("region", { name: "Your history" });
    expect(section).toHaveTextContent("Your history: likely response 62% (41–79%)");
    expect(section).toHaveTextContent("Raises: Skills, Role · Lowers: Freshness");
    expect(section).toHaveTextContent("not a cause or a guarantee");
  });

  it("shows no history section without a prediction", async () => {
    mockFetch({ job, applicationId: null, match: { ...match, personal: null } });
    render(<MatchDetailClient jobId="j1" />);
    await screen.findByRole("heading", { name: "Data Engineer" });
    expect(screen.queryByRole("region", { name: "Your history" })).not.toBeInTheDocument();
  });

  it("shows the job, score, and the strong/partial/gap breakdown", async () => {
    mockFetch({ job, match });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("Data Engineer")).toBeInTheDocument();
    expect(screen.getByText("82/100")).toBeInTheDocument();
    expect(screen.getByText("Strong SQL alignment")).toBeInTheDocument();
    expect(screen.getByText("Slightly under target salary")).toBeInTheDocument();
    expect(screen.getByText("Tableau requested, not found")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Application autofill" })).toBeInTheDocument();
  });

  it("shows the ineligible reason instead of scores when excluded", async () => {
    mockFetch({ job, match: { ...match, eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null, explanation: null } });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
  });

  it("shows a not-found state for a 404", async () => {
    mockFetch({ error: "Match not found" }, 404);
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });

  it("never shows a carried-forward score or explanation once a match becomes ineligible", async () => {
    // upsertMatchRow deliberately carries explanation/overallScore-shaped fields forward from the previous
    // row on recompute in some paths; the UI must still gate their *display* on eligible, not just presence.
    mockFetch({
      job,
      match: { ...match, eligible: false, ineligibleReason: "You dismissed this job." },
    });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
    expect(screen.queryByText("82/100")).not.toBeInTheDocument();
    expect(screen.queryByText("Strong SQL alignment")).not.toBeInTheDocument();
    expect(screen.queryByText("Slightly under target salary")).not.toBeInTheDocument();
    expect(screen.queryByText("Tableau requested, not found")).not.toBeInTheDocument();
    expect(screen.queryByText("A strong overall match.")).not.toBeInTheDocument();
  });

  it("keeps the document panels for an applied job even when it is no longer eligible", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      url.startsWith("/api/matches/")
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({
            job: { id: "j1", title: "DE", companyName: "Acme", locationRaw: null, workMode: "remote", descriptionText: "" },
            match: { eligible: false, ineligibleReason: "You applied to this job at Acme.", overallScore: null, factors: null, explanation: null, userAction: "none" },
            applicationId: "a1",
          }) } as Response)
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ application: null, documentOptions: { resumes: [], pitches: [], coverLetters: [] }, documents: [], optimizations: [], versions: [], research: null, support: { supported: false, reason: "no_supported_posting" }, resumeAvailable: false, applicationId: null, sessions: [] }) } as Response)
    ));
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByRole("heading", { name: "Application" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Documents" })).toBeInTheDocument();
  });
});
