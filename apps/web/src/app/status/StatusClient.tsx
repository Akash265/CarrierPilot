"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusReport } from "../../lib/status/loadStatus";
import type { WorkerState } from "@ai-career/monitoring";
import { lastSeen, utcMinute, workerLabel } from "../../lib/status/format";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: StatusReport };

const REFRESH_MS = 30_000;
const STATE_LABEL: Record<WorkerState, string> = { running: "Running", stopped: "Stopped", stale: "Stale", never_seen: "Never seen" };
const STATE_CLASS: Record<WorkerState, string> = {
  running: "bg-green-100",
  stopped: "bg-gray-100",
  stale: "bg-amber-100",
  never_seen: "bg-gray-100",
};

export function StatusClient() {
  const [state, setState] = useState<State>({ kind: "loading" });
  // Only the newest request may update the page: a slow, older response must not overwrite a newer one.
  const latest = useRef(0);

  // A promise chain, not async/await: see the note in SourcesClient (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    const id = ++latest.current;
    fetch("/api/status", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json() as Promise<StatusReport>;
      })
      .then((data) => {
        if (id === latest.current) setState({ kind: "ready", data });
      })
      .catch(() => {
        if (id === latest.current) setState({ kind: "error" });
      });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const now = new Date();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4 text-sm">
        <button type="button" onClick={load} className="rounded border px-3 py-1">
          Refresh
        </button>
        {state.kind === "ready" && <span className="text-gray-600">{`Checked ${state.data.checkedAt.slice(11, 19)} UTC`}</span>}
      </div>

      {state.kind === "loading" && <p className="text-sm text-gray-600">Loading…</p>}
      {state.kind === "error" && <p className="text-sm text-red-700">Could not load the system status.</p>}

      {state.kind === "ready" && (
        <>
          {state.data.database === "unavailable" && <p className="rounded bg-red-100 px-2 py-1 text-sm">The database is unavailable.</p>}
          {state.data.redis === "unavailable" ? (
            <p className="rounded bg-red-100 px-2 py-1 text-sm">Redis is unavailable, so worker and queue status cannot be read.</p>
          ) : (
            <>
              <table aria-label="Workers" className="text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="pr-4">Worker</th>
                    <th className="pr-4">State</th>
                    <th className="pr-4">Last seen</th>
                    <th>Started (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.workers.map((w) => (
                    <tr key={w.worker} className="border-t">
                      <td className="py-1 pr-4">
                        {workerLabel(w.worker)}
                        {w.optional && (
                          <>
                            {" "}
                            <span className="rounded bg-gray-100 px-1 text-xs text-gray-600">optional</span>
                          </>
                        )}
                      </td>
                      <td className="pr-4">
                        <span className={`rounded px-2 py-0.5 text-xs ${STATE_CLASS[w.state]}`}>{STATE_LABEL[w.state]}</span>
                      </td>
                      <td className="pr-4">{lastSeen(w.lastSeenAt, now)}</td>
                      <td>{utcMinute(w.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <table aria-label="Queues" className="text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="pr-4">Queue</th>
                    <th className="pr-4">Waiting</th>
                    <th className="pr-4">Active</th>
                    <th className="pr-4">Delayed</th>
                    <th className="pr-4">Failed</th>
                    <th>Last failure (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.queues.map((q) => (
                    <tr key={q.queue} className="border-t">
                      <td className="py-1 pr-4">{q.queue}</td>
                      <td className="pr-4">{q.waiting}</td>
                      <td className="pr-4">{q.active}</td>
                      <td className="pr-4">{q.delayed}</td>
                      <td className="pr-4">{q.failed}</td>
                      <td>{q.lastFailedAt ? `${utcMinute(q.lastFailedAt)} · ${q.lastFailedCode ?? "see the worker log"}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500">Failed counts include only the failed jobs each queue keeps, not a lifetime total.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
