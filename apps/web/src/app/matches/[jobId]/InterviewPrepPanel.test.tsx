// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { InterviewPrepPanel, formatInterviewPrepText } from "./InterviewPrepPanel";

const NOW_ISO = new Date().toISOString();
const ok = { supported: true, unsupportedReason: null, evidence: [] };
const prep = {
  id: "i1", version: 1, requiresReview: false, researchStatus: "ok", researchedAt: NOW_ISO, generationModel: "research-model", createdAt: NOW_ISO,
  gapTerms: ["Kubernetes"],
  sections: {
    likelyQuestions: [{ question: "Tell me about SQL.", category: "technical", answerOutline: ["Pipeline", "Scale"], ...ok }],
    gapQuestions: [{ question: "Have you used Kubernetes?", requirementTerm: "Kubernetes", framing: "Be honest; mention Docker.", ...ok }],
    talkingPoints: [{ text: "Acme builds rockets.", ...ok }],
    questionsToAsk: [{ question: "How big is the team?", ...ok }],
  },
};

function mockFetchSequence(responses: { body: unknown; status?: number }[]) {
  const fn = vi.fn();
  for (const { body, status = 200 } of responses) fn.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

describe("InterviewPrepPanel", () => {
  it("shows an empty state and a Generate button", async () => {
    mockFetchSequence([{ body: { versions: [], research: null } }]);
    render(<InterviewPrepPanel jobId="j1" />);
    expect(await screen.findByText(/no interview prep generated yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Interview Prep" })).toBeInTheDocument();
  });

  it("renders the four sections and the gap terms", async () => {
    mockFetchSequence([{ body: { versions: [prep], research: null } }]);
    render(<InterviewPrepPanel jobId="j1" />);
    expect(await screen.findByText("Tell me about SQL.")).toBeInTheDocument();
    for (const h of ["Likely questions", "Required skills not found in your profile", "Company talking points", "Questions to ask"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    expect(within(screen.getByRole("list", { name: "Missing required terms" })).getByText("Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("Missing: Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("Be honest; mention Docker.")).toBeInTheDocument();
    expect(screen.getByText("Pipeline")).toBeInTheDocument();
  });

  it("labels an unsupported gap question's term without calling it missing", async () => {
    const flagged = {
      ...prep,
      requiresReview: true,
      sections: {
        ...prep.sections,
        gapQuestions: [{ question: "SQL?", requirementTerm: "SQL", framing: "F.", supported: false, unsupportedReason: 'requirementTerm "SQL" is not one of the missing required terms', evidence: [] }],
      },
    };
    mockFetchSequence([{ body: { versions: [flagged], research: null } }]);
    render(<InterviewPrepPanel jobId="j1" />);
    expect(await screen.findByText("Term: SQL")).toBeInTheDocument();
    expect(screen.queryByText("Missing: SQL")).not.toBeInTheDocument();
  });

  it("says every required term is covered when there are no gap terms", async () => {
    mockFetchSequence([{ body: { versions: [{ ...prep, gapTerms: [], sections: { ...prep.sections, gapQuestions: [] } }], research: null } }]);
    render(<InterviewPrepPanel jobId="j1" />);
    expect(await screen.findByText(/none: every required term appears in your profile/i)).toBeInTheDocument();
  });

  it("flags unsupported items and shows a review banner counting them", async () => {
    const flagged = { ...prep, requiresReview: true, sections: { ...prep.sections, talkingPoints: [{ text: "Unsourced.", supported: false, unsupportedReason: "cites no company research", evidence: [] }] } };
    mockFetchSequence([{ body: { versions: [flagged], research: null } }]);
    render(<InterviewPrepPanel jobId="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 item could not be verified/i);
    expect(screen.getByText(/cites no company research/)).toBeInTheDocument();
  });

  it("calls the run endpoint on Regenerate and reloads", async () => {
    const fetchMock = mockFetchSequence([
      { body: { versions: [prep], research: null } },
      { body: { interviewPrep: { ...prep, id: "i2", version: 2 }, research: null }, status: 201 },
      { body: { versions: [{ ...prep, id: "i2", version: 2 }, prep], research: null } },
    ]);
    render(<InterviewPrepPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/interview-preps/j1/run");
  });
});

describe("formatInterviewPrepText", () => {
  it("formats all sections as plain text", () => {
    const text = formatInterviewPrepText(prep as never);
    expect(text).toContain("Likely questions\n- Tell me about SQL. (technical)\n  • Pipeline\n  • Scale");
    expect(text).toContain("Required skills not found in your profile: Kubernetes");
    expect(text).toContain("- Have you used Kubernetes?\n  Be honest; mention Docker.");
    expect(text).toContain("Company talking points\n- Acme builds rockets.");
    expect(text).toContain("Questions to ask\n- How big is the team?");
    expect(text).not.toContain("(unverified)");
  });

  it("marks unsupported items (unverified), like the export", () => {
    const bad = { supported: false, unsupportedReason: "x", evidence: [] };
    const text = formatInterviewPrepText({
      ...prep,
      sections: {
        likelyQuestions: [{ ...prep.sections.likelyQuestions[0], ...bad }],
        gapQuestions: [{ ...prep.sections.gapQuestions[0], ...bad }],
        talkingPoints: [{ text: "Acme builds rockets.", ...bad }],
        questionsToAsk: [{ question: "How big is the team?", ...bad }],
      },
    } as never);
    expect(text).toContain("- Tell me about SQL. (unverified) (technical)");
    expect(text).toContain("- Have you used Kubernetes? (unverified)\n  Be honest; mention Docker.");
    expect(text).toContain("- Acme builds rockets. (unverified)");
    expect(text).toContain("- How big is the team? (unverified)");
  });
});
