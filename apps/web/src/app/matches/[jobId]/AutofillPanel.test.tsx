// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AutofillPanel, APPLICATION_RECORDED_EVENT } from "./AutofillPanel";

beforeEach(() => vi.unstubAllGlobals());

const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => body } as Response);
const session = (over: Record<string, unknown> = {}) => ({
  id: "s1", jobId: "j1", status: "awaiting_user", portal: "greenhouse", formUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
  errorCode: null, applicationId: null, cancelRequested: false, createdAt: new Date().toISOString(),
  fieldAudit: [
    { key: "f0", label: "Email", required: true, canonical: "email", action: "filled", reason: null, valueSource: "profile.email", verified: true },
    { key: "f1", label: "Phone", required: false, canonical: "phone", action: "flagged", reason: "verify_mismatch", valueSource: "profile.phoneNumber", verified: false },
    { key: "f2", label: "Will you require sponsorship?", required: true, canonical: "sponsorship", action: "flagged", reason: "unsupported_control", valueSource: null, verified: null },
    { key: "f3", label: "Gender", required: false, canonical: "eeo", action: "skipped", reason: "intentionally_not_filled", valueSource: null, verified: null },
  ],
  ...over,
});
const overview = (over: Record<string, unknown> = {}) => ({
  support: { supported: true, portal: "greenhouse", adapterVersion: "greenhouse-v1", formUrl: "https://job-boards.greenhouse.io/acme/jobs/1" },
  resumeAvailable: true, applicationId: null, sessions: [], ...over,
});

describe("AutofillPanel", () => {
  it("explains why autofill is unavailable for an unsupported job", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ support: { supported: false, reason: "no_supported_posting" } }))));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/only available for jobs from a Greenhouse or Lever source/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /autofill/i })).not.toBeInTheDocument();
  });

  it("disables the button until a resume PDF exists", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ resumeAvailable: false }))));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByRole("button", { name: "Open & autofill application (Greenhouse)" })).toBeDisabled();
    expect(screen.getByText(/export a resume pdf for this job first/i)).toBeInTheDocument();
  });

  it("starts a session and shows the audit with flagged fields first", async () => {
    let started = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        started = true;
        return json({ session: session({ status: "queued", fieldAudit: [] }) }, true, 201);
      }
      return json(overview({ sessions: started ? [session()] : [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutofillPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open & autofill application (Greenhouse)" }));
    await screen.findByText("Waiting for you in the browser window");
    expect(fetchMock).toHaveBeenCalledWith("/api/automation-sessions", expect.objectContaining({ method: "POST", body: JSON.stringify({ jobId: "j1" }) }));
    const lists = screen.getAllByRole("list");
    expect(within(lists[0]).getByText(/Will you require sponsorship\?/)).toBeInTheDocument();
    expect(screen.getByText(/complete these in the browser window, then click submit yourself/i)).toBeInTheDocument();
    expect(screen.getByText(/value did not stick/i)).toBeInTheDocument();
    expect(screen.getByText(/intentionally not filled/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open & autofill application (Greenhouse)" })).toBeDisabled();
  });

  it("cancels the active session", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ session: session({ status: "abandoned" }) }) : json(overview({ sessions: [session()] }))
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AutofillPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/automation-sessions/s1/cancel", { method: "POST" }));
  });

  it("records a detected submission as applied and announces it", async () => {
    const listener = vi.fn();
    window.addEventListener(APPLICATION_RECORDED_EVENT, listener);
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ application: { id: "a1" } }, true, 201)
        : json(overview({ sessions: [session({ status: "submission_detected" })] }))
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/looks like you submitted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record as applied" }));
    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/applications", expect.objectContaining({
      method: "POST", body: JSON.stringify({ jobId: "j1", automationSessionId: "s1" }),
    }));
    window.removeEventListener(APPLICATION_RECORDED_EVENT, listener);
  });

  it("offers recording after an abandoned session but not once an application exists", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ sessions: [session({ status: "abandoned", errorCode: "window_closed" })] }))));
    const { unmount } = render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/did you submit anyway/i)).toBeInTheDocument();
    unmount();
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ applicationId: "a1", sessions: [session({ status: "submission_detected" })] }))));
    render(<AutofillPanel jobId="j1" />);
    await screen.findByText("Submission detected");
    expect(screen.queryByRole("button", { name: "Record as applied" })).not.toBeInTheDocument();
  });

  it("explains a needs-manual session and links the form", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(overview({ sessions: [session({ status: "needs_manual", errorCode: "health_check_failed", fieldAudit: [] })] }))));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByText(/did not look like the known/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the form yourself/i })).toHaveAttribute("href", "https://job-boards.greenhouse.io/acme/jobs/1");
  });

  it("shows a load error for a malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ unexpected: true })));
    render(<AutofillPanel jobId="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
  });
});
