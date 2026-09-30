// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApplicationPanel } from "./ApplicationPanel";

beforeEach(() => vi.unstubAllGlobals());

const options = {
  resumes: [{ id: "r2", version: 2, origin: null }, { id: "r1", version: 1, origin: null }],
  pitches: [{ id: "p1", version: 1, origin: "user_edited" }],
  coverLetters: [],
};
const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => body } as Response);

describe("ApplicationPanel", () => {
  it("preselects the newest version of each document and posts the choice", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ application: { id: "a1", status: "applied", appliedAt: "2026-09-30" } }, true, 201)
        : json({ application: null, documentOptions: options })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationPanel jobId="j1" />);

    expect(await screen.findByLabelText(/resume version/i)).toHaveValue("r2");
    expect(screen.getByLabelText(/pitch version/i)).toHaveValue("p1");
    expect(screen.getByLabelText(/cover letter version/i)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /mark as applied/i }));

    expect(await screen.findByText(/applied on 2026-09-30/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open in tracker/i })).toHaveAttribute("href", "/applications/a1");
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ jobId: "j1", resumeOptimizationId: "r2", applicationPitchId: "p1", coverLetterId: null });
  });

  it("shows the existing application instead of the form", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ application: { id: "a1", status: "interviewing", appliedAt: "2026-09-01" }, documentOptions: options })));
    render(<ApplicationPanel jobId="j1" />);
    expect(await screen.findByText(/applied on 2026-09-01 · interviewing/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark as applied/i })).not.toBeInTheDocument();
  });

  it("shows the server's error message when creation fails", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "You already have an application for this job" }, false, 409) : json({ application: null, documentOptions: options })
    ));
    render(<ApplicationPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: /mark as applied/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/already have an application/i));
  });
});
