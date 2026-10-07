// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { StatusClient } from "./StatusClient";
import type { StatusReport } from "../../lib/status/loadStatus";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

function report(over: Partial<StatusReport> = {}): StatusReport {
  return {
    checkedAt: "2026-10-07T12:00:00.000Z",
    database: "ok",
    redis: "ok",
    workers: [
      { worker: "job-ingestion", optional: false, state: "running", startedAt: "2026-10-07T08:00:00.000Z", lastSeenAt: "2026-10-07T11:59:48.000Z", stoppedAt: null },
      { worker: "matching", optional: false, state: "stale", startedAt: "2026-10-07T08:00:00.000Z", lastSeenAt: "2026-10-07T11:57:00.000Z", stoppedAt: null },
      { worker: "maintenance", optional: true, state: "stopped", startedAt: "2026-10-06T08:00:00.000Z", lastSeenAt: "2026-10-07T10:00:00.000Z", stoppedAt: "2026-10-07T10:00:00.000Z" },
      { worker: "browser", optional: true, state: "never_seen", startedAt: null, lastSeenAt: null, stoppedAt: null },
    ],
    queues: [
      { queue: "job-ingestion", waiting: 0, active: 1, delayed: 3, failed: 2, lastFailedAt: "2026-10-07T09:30:00.000Z", lastFailedCode: "rate_limited" },
      { queue: "matching", waiting: 1, active: 0, delayed: 0, failed: 1, lastFailedAt: "2026-10-07T09:31:00.000Z", lastFailedCode: null },
      { queue: "maintenance", waiting: 0, active: 0, delayed: 1, failed: 0, lastFailedAt: null, lastFailedCode: null },
      { queue: "browser-automation", waiting: 0, active: 0, delayed: 0, failed: 0, lastFailedAt: null, lastFailedCode: null },
    ],
    ...over,
  };
}

const rows = (table: HTMLElement) =>
  within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function serve(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => body } as Response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("StatusClient", () => {
  it("lists each worker with its state, last-seen time, start time and an optional tag", async () => {
    serve(report());
    render(<StatusClient />);
    const table = await screen.findByRole("table", { name: "Workers" });
    expect(rows(table)).toEqual([
      ["Job ingestion", "Running", "12 s ago", "2026-10-07 08:00"],
      ["Matching", "Stale", "3 min ago", "2026-10-07 08:00"],
      ["Maintenance optional", "Stopped", "2 h ago", "2026-10-06 08:00"],
      ["Browser autofill optional", "Never seen", "—", "—"],
    ]);
  });

  it("lists each queue's counts and last failure, withholding non-code reasons", async () => {
    serve(report());
    render(<StatusClient />);
    const table = await screen.findByRole("table", { name: "Queues" });
    expect(rows(table)).toEqual([
      ["job-ingestion", "0", "1", "3", "2", "2026-10-07 09:30 · rate_limited"],
      ["matching", "1", "0", "0", "1", "2026-10-07 09:31 · see the worker log"],
      ["maintenance", "0", "0", "1", "0", "—"],
      ["browser-automation", "0", "0", "0", "0", "—"],
    ]);
    expect(screen.getByText("Failed counts include only the failed jobs each queue keeps, not a lifetime total.")).toBeInTheDocument();
  });

  it("says when Redis or the database is unavailable", async () => {
    serve(report({ redis: "unavailable", database: "unavailable", workers: [], queues: [] }));
    render(<StatusClient />);
    expect(await screen.findByText("Redis is unavailable, so worker and queue status cannot be read.")).toBeInTheDocument();
    expect(screen.getByText("The database is unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("refreshes on the button and every 30 seconds, showing the newest response", async () => {
    const fetchMock = serve(report(), report({ checkedAt: "2026-10-07T12:00:05.000Z" }), report({ checkedAt: "2026-10-07T12:00:35.000Z" }));
    render(<StatusClient />);
    expect(await screen.findByText("Checked 12:00:00 UTC")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Checked 12:00:05 UTC")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await screen.findByText("Checked 12:00:35 UTC")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith("/api/status", { cache: "no-store" });
  });

  it("ignores a slower, older response that arrives after a newer one", async () => {
    let releaseFirst!: (v: unknown) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => report({ checkedAt: "2026-10-07T12:00:09.000Z" }) } as Response));
    vi.stubGlobal("fetch", fetchMock);
    render(<StatusClient />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Checked 12:00:09 UTC")).toBeInTheDocument();
    releaseFirst({ ok: true, json: async () => report({ checkedAt: "2026-10-07T11:59:00.000Z" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("Checked 12:00:09 UTC")).toBeInTheDocument();
  });

  it("shows an error when the status cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, json: async () => ({}) } as Response)));
    render(<StatusClient />);
    expect(await screen.findByText("Could not load the system status.")).toBeInTheDocument();
  });
});
