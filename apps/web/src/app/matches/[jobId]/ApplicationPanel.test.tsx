// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApplicationPanel } from "./ApplicationPanel";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

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

  it("shows the server's error message when creation fails and the reload still finds no application", async () => {
    // Every GET (mount-time load and the post-409 reload) returns no application, so the error must stick.
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "You already have an application for this job" }, false, 409) : json({ application: null, documentOptions: options })
    ));
    render(<ApplicationPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: /mark as applied/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/already have an application/i));
    expect(screen.queryByRole("link", { name: /open in tracker/i })).not.toBeInTheDocument();
  });

  it("shows the server's error message when creation fails and the reload itself fails", async () => {
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ error: "You already have an application for this job" }, false, 409);
      gets += 1;
      // GET #1 (mount) and #2 (submit's pre-POST re-fetch) succeed with no application;
      // GET #3, the reload triggered by the 409, fails.
      return gets <= 2 ? json({ application: null, documentOptions: options }) : Promise.reject(new Error("network error"));
    }));
    render(<ApplicationPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: /mark as applied/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/already have an application/i));
  });

  it("switches to the applied state when a 409 means another tab already recorded the application", async () => {
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ error: "You already have an application for this job" }, false, 409);
      gets += 1;
      // GET #1 (mount) and #2 (submit's pre-POST re-fetch) find nothing yet; GET #3, the reload
      // triggered by the 409, finds the application that the other tab recorded in the meantime.
      return gets <= 2
        ? json({ application: null, documentOptions: options })
        : json({ application: { id: "a1", status: "applied", appliedAt: "2026-09-30" }, documentOptions: options });
    }));
    render(<ApplicationPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: /mark as applied/i }));
    expect(await screen.findByText(/applied on 2026-09-30/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open in tracker/i })).toHaveAttribute("href", "/applications/a1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("submits the newest versions from a fresh fetch, not the stale mount-time options", async () => {
    const fresh = { ...options, pitches: [{ id: "p2", version: 1, origin: null }] };
    let gets = 0;
    const fetchMock = vi.fn((_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ application: { id: "a1", status: "applied", appliedAt: "2026-09-30" } }, true, 201);
      gets += 1;
      return json({ application: null, documentOptions: gets === 1 ? { ...options, pitches: [] } : fresh });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationPanel jobId="j1" />);
    expect(await screen.findByLabelText(/pitch version/i)).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: /mark as applied/i }));
    expect(await screen.findByText(/applied on 2026-09-30/i)).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ resumeOptimizationId: "r2", applicationPitchId: "p2" });
  });

  it("refreshes the options when documents change on the page", async () => {
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      gets += 1;
      return json({ application: null, documentOptions: gets === 1 ? { ...options, pitches: [] } : { ...options, pitches: [{ id: "p2", version: 1, origin: null }] } });
    }));
    render(<ApplicationPanel jobId="j1" />);
    expect(await screen.findByLabelText(/pitch version/i)).toHaveValue("");
    window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByLabelText(/pitch version/i)).toHaveValue("p2"));
  });

  it("keeps an explicit None choice even when fresh options contain a resume", async () => {
    let gets = 0;
    const fetchMock = vi.fn((_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ application: { id: "a1", status: "applied", appliedAt: "2026-09-30" } }, true, 201);
      gets += 1;
      const resumes = gets === 1 ? options.resumes : [{ id: "r3", version: 3, origin: null }, ...options.resumes];
      return json({ application: null, documentOptions: { ...options, resumes } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationPanel jobId="j1" />);
    fireEvent.change(await screen.findByLabelText(/resume version/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /mark as applied/i }));
    expect(await screen.findByText(/applied on 2026-09-30/i)).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ resumeOptimizationId: null, applicationPitchId: "p1" });
  });
});
