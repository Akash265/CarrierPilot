// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApplicationsClient } from "./ApplicationsClient";

beforeEach(() => vi.unstubAllGlobals());

const app = (over: Record<string, unknown>) => ({
  id: "a1", jobId: "j1", companyName: "Acme", jobTitle: "Data Engineer", status: "applied", appliedAt: "2026-09-01",
  followUpAt: null, external: false, ...over,
});
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: true, status, json: async () => body } as Response);

function mockApi(all: unknown[], due: unknown[]) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return ok({}, 201);
    return ok(url.includes("due=1") ? { applications: due, dueCount: due.length } : { applications: all, dueCount: due.length });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ApplicationsClient", () => {
  it("lists applications with status, an external tag and a link to the detail page", async () => {
    mockApi([app({}), app({ id: "a2", jobId: null, companyName: "Globex", external: true, status: "rejected" })], []);
    render(<ApplicationsClient />);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: /acme/i })).toHaveAttribute("href", "/applications/a1");
    expect(within(table).getByText("External")).toBeInTheDocument();
    expect(within(table).getByText("Rejected")).toBeInTheDocument();
  });

  it("filters by status chip", async () => {
    mockApi([app({}), app({ id: "a2", companyName: "Globex", status: "rejected" })], []);
    render(<ApplicationsClient />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Rejected" }));
    expect(screen.queryByRole("link", { name: /acme/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /globex/i })).toBeInTheDocument();
  });

  it("shows due follow-ups and marks one done", async () => {
    const fetchMock = mockApi([app({ followUpAt: "2026-09-10" })], [app({ followUpAt: "2026-09-10" })]);
    render(<ApplicationsClient />);
    const due = await screen.findByRole("region", { name: /follow-ups due/i });
    fireEvent.click(within(due).getByRole("button", { name: /done/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post?.[0]).toBe("/api/applications/a1/events");
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ type: "follow_up_done", detail: {} });
    });
  });

  it("shows an empty state", async () => {
    mockApi([], []);
    render(<ApplicationsClient />);
    expect(await screen.findByText(/no applications yet/i)).toBeInTheDocument();
  });
});
