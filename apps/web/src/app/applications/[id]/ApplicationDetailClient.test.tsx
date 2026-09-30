// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApplicationDetailClient } from "./ApplicationDetailClient";

beforeEach(() => vi.unstubAllGlobals());

const application = {
  id: "a1", jobId: "j1", companyName: "Acme", jobTitle: "Data Engineer", jobUrl: "https://jobs.example/1", status: "interviewing",
  appliedAt: "2026-09-01", followUpAt: null, recruiterName: null, recruiterContact: null, salaryNotes: null, notes: null,
  terminalAt: null, retentionPurgedAt: null as string | null, external: false,
  snapshotSummary: { matchOverall: 78, atsOverall: 82, documents: { resume: 3, pitch: 2, coverLetter: null } },
};
const events = [{ id: "e1", type: "status_change", occurredAt: "2026-09-01T00:00:00Z", fromStatus: null, toStatus: "applied", detail: {} }];

function mockApi(app = application) {
  const fn = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve({ ok: true, status: init?.method === "DELETE" ? 204 : 200, json: async () => ({ application: app, events }) } as Response)
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ApplicationDetailClient", () => {
  it("shows the header, snapshot line, sent documents and timeline", async () => {
    mockApi();
    render(<ApplicationDetailClient id="a1" retentionDays={30} />);
    expect(await screen.findByRole("heading", { name: /acme — data engineer/i })).toBeInTheDocument();
    expect(screen.getByText(/match 78 · ats 82 at time of applying/i)).toBeInTheDocument();
    expect(screen.getByText(/resume v3/i)).toBeInTheDocument();
    expect(screen.getByText(/pitch v2/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open job workspace/i })).toHaveAttribute("href", "/matches/j1");
    // "Applied" is also a status <option>, so scope the timeline assertion to its region.
    expect(within(screen.getByRole("region", { name: /timeline/i })).getByText(/applied/i)).toBeInTheDocument();
  });

  it("asks for confirmation before a terminal status and does nothing if declined", async () => {
    const fetchMock = mockApi();
    const confirm = vi.fn(() => false);
    render(<ApplicationDetailClient id="a1" retentionDays={30} confirm={confirm} />);
    fireEvent.change(await screen.findByLabelText(/new status/i), { target: { value: "rejected" } });
    fireEvent.click(screen.getByRole("button", { name: /update status/i }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/deleted 30 days/i));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/status"))).toBe(false);
  });

  it("posts a confirmed status change", async () => {
    const fetchMock = mockApi();
    render(<ApplicationDetailClient id="a1" retentionDays={30} confirm={() => true} />);
    fireEvent.change(await screen.findByLabelText(/new status/i), { target: { value: "rejected" } });
    fireEvent.click(screen.getByRole("button", { name: /update status/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/status"));
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({ toStatus: "rejected" });
    });
  });

  it("says documents were deleted once purged", async () => {
    mockApi({ ...application, status: "rejected", retentionPurgedAt: "2026-11-01T00:00:00Z" });
    render(<ApplicationDetailClient id="a1" retentionDays={30} />);
    expect(await screen.findByText(/documents deleted after the retention period/i)).toBeInTheDocument();
  });

  it("deletes after confirmation and navigates back to the list", async () => {
    mockApi();
    const navigate = vi.fn();
    render(<ApplicationDetailClient id="a1" retentionDays={30} confirm={() => true} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: /delete application/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/applications"));
  });
});
