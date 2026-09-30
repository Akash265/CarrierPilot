// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CoverLetterPanel } from "./CoverLetterPanel";

const NOW_ISO = new Date().toISOString();
const paragraphs = [
  { role: "opening", text: "I am applying.", supported: true, unsupportedReason: null, evidence: [{ id: "q:1", kind: "requirement", text: "[required] SQL", sourceUrl: null }] },
  { role: "company", text: "Acme builds rockets.", supported: true, unsupportedReason: null, evidence: [] },
  { role: "evidence", text: "I built pipelines.", supported: true, unsupportedReason: null, evidence: [] },
  { role: "closing", text: "Thank you.", supported: true, unsupportedReason: null, evidence: [] },
];
const letter = {
  id: "c1", version: 1, origin: "generated", parentCoverLetterId: null, paragraphs, requiresReview: false,
  researchStatus: "ok", researchedAt: NOW_ISO, generationModel: "fast-model", createdAt: NOW_ISO,
};
const research = { id: "r1", companyName: "Acme", status: "ok", researchedAt: NOW_ISO, searchCount: 2, facts: [] };

function mockFetchSequence(responses: { body: unknown; status?: number }[]) {
  const fn = vi.fn();
  for (const { body, status = 200 } of responses) fn.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

describe("CoverLetterPanel", () => {
  it("shows the optional note, an empty state and a Generate button", async () => {
    mockFetchSequence([{ body: { versions: [], research: null } }]);
    render(<CoverLetterPanel jobId="j1" />);
    expect(await screen.findByText(/no cover letter generated yet/i)).toBeInTheDocument();
    expect(screen.getByText(/only if the application asks for one/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Cover Letter" })).toBeInTheDocument();
  });

  it("renders the paragraphs in order with their labels", async () => {
    mockFetchSequence([{ body: { versions: [letter], research } }]);
    render(<CoverLetterPanel jobId="j1" />);
    expect(await screen.findByText("I am applying.")).toBeInTheDocument();
    for (const label of ["Opening", "Why this company", "Evidence of fit", "Closing"]) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("numbers the two evidence textareas when editing a five-paragraph letter, and keeps a single one unnumbered", async () => {
    const five = { ...letter, paragraphs: [paragraphs[0], paragraphs[1], paragraphs[2], { ...paragraphs[2], text: "I led migrations." }, paragraphs[3]] };
    mockFetchSequence([{ body: { versions: [five], research } }]);
    const { unmount } = render(<CoverLetterPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Evidence of fit 1" })).toHaveValue("I built pipelines.");
    expect(screen.getByRole("textbox", { name: "Evidence of fit 2" })).toHaveValue("I led migrations.");
    unmount();

    mockFetchSequence([{ body: { versions: [letter], research } }]);
    render(<CoverLetterPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Evidence of fit" })).toHaveValue("I built pipelines.");
  });

  it("shows a review banner naming each unsupported paragraph", async () => {
    const flagged = { ...letter, requiresReview: true, paragraphs: [paragraphs[0], paragraphs[1], { ...paragraphs[2], supported: false, unsupportedReason: "cites no profile evidence" }, paragraphs[3]] };
    mockFetchSequence([{ body: { versions: [flagged], research } }]);
    render(<CoverLetterPanel jobId="j1" />);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Evidence of fit: cites no profile evidence");
  });

  it("notes when the selected version's web research was unavailable", async () => {
    mockFetchSequence([{ body: { versions: [{ ...letter, researchStatus: "failed" }], research } }]);
    render(<CoverLetterPanel jobId="j1" />);
    expect(await screen.findByText(/web research unavailable/i)).toBeInTheDocument();
  });

  it("calls the run endpoint then reloads on Regenerate, and shows server errors", async () => {
    const fetchMock = mockFetchSequence([
      { body: { versions: [letter], research } },
      { body: { error: "Confirm your profile first" }, status: 409 },
    ]);
    render(<CoverLetterPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    expect(await screen.findByText("Confirm your profile first")).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/cover-letters/j1/run");
  });

  it("saves an edit as a new version with the base id and every paragraph", async () => {
    const fetchMock = mockFetchSequence([
      { body: { versions: [letter], research } },
      { body: { coverLetter: { ...letter, id: "c2", version: 2, origin: "user_edited" } }, status: 201 },
      { body: { versions: [{ ...letter, id: "c2", version: 2, origin: "user_edited" }, letter], research } },
    ]);
    render(<CoverLetterPanel jobId="j1" />);
    await screen.findByText("I am applying.");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Closing" }), { target: { value: "Best regards." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/cover-letters/j1/edit");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      baseVersionId: "c1",
      paragraphs: ["I am applying.", "Acme builds rockets.", "I built pipelines.", "Best regards."],
    });
  });

  it("labels an edited version's paragraphs as your wording and offers downloads", async () => {
    const edited = { ...letter, id: "c2", version: 2, origin: "user_edited", paragraphs: paragraphs.map((p) => ({ ...p, supported: null })) };
    mockFetchSequence([{ body: { versions: [edited, letter], research } }]);
    render(<CoverLetterPanel jobId="j1" />);
    expect(await screen.findAllByText("your wording")).toHaveLength(4);
    const section = screen.getByRole("region", { name: /cover letter/i });
    expect(within(section).getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
  });
});
