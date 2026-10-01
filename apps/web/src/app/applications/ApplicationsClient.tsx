"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { STATUS_LABELS, STATUS_ORDER } from "../../lib/applications/statusLabels";
import { ExternalApplicationForm } from "./ExternalApplicationForm";

interface Row {
  id: string;
  companyName: string;
  jobTitle: string;
  status: string;
  appliedAt: string;
  followUpAt: string | null;
  external: boolean;
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; all: Row[]; due: Row[] };

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function ApplicationsClient() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [filter, setFilter] = useState<string>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [snoozeTo, setSnoozeTo] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    Promise.all([fetch("/api/applications"), fetch("/api/applications?due=1")])
      .then(async ([all, due]) => {
        if (!all.ok || !due.ok) throw new Error("load failed");
        return [await all.json(), await due.json()];
      })
      .then(([all, due]) => {
        if (!ignore) setState({ kind: "ready", all: all.applications, due: due.applications });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const postFollowUp = async (id: string, body: object) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/applications/${id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed");
      reload();
    } catch {
      setActionError("Could not update the follow-up. Try again.");
    }
  };

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load applications.</p>;

  const rows = filter === "all" ? state.all : state.all.filter((r) => r.status === filter);

  return (
    <div className="flex flex-col gap-6">
      {state.due.length > 0 && (
        <section aria-labelledby="due-heading" className="rounded border border-amber-400 p-4">
          <h2 id="due-heading" className="mb-2 font-medium">Follow-ups due</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {state.due.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/applications/${r.id}`} className="underline">{r.companyName} — {r.jobTitle}</Link>
                <span className="text-gray-600">due {r.followUpAt}</span>
                <button type="button" onClick={() => postFollowUp(r.id, { type: "follow_up_done", detail: {} })} className="rounded border px-2 py-0.5">Done</button>
                <input
                  type="date"
                  aria-label={`Snooze ${r.companyName} until`}
                  value={snoozeTo[r.id] ?? inDays(7)}
                  onChange={(e) => setSnoozeTo((s) => ({ ...s, [r.id]: e.target.value }))}
                  className="rounded border p-0.5"
                />
                <button
                  type="button"
                  onClick={() => postFollowUp(r.id, { type: "follow_up_snoozed", detail: { newFollowUpAt: snoozeTo[r.id] ?? inDays(7) } })}
                  className="rounded border px-2 py-0.5"
                >
                  Snooze
                </button>
              </li>
            ))}
          </ul>
          {actionError && <p role="alert" className="mt-2 text-sm text-red-600">{actionError}</p>}
        </section>
      )}

      <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label="Filter by status">
        {["all", ...STATUS_ORDER].map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
            className={`rounded-full border px-3 py-0.5 ${filter === s ? "bg-black text-white" : ""}`}
          >
            {s === "all" ? "All" : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {state.all.length === 0 ? (
        <p className="text-sm text-gray-600">No applications yet. Mark a match as applied, or add an external application below.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b"><th className="py-1">Company / title</th><th>Status</th><th>Applied</th><th>Follow-up</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="py-1">
                  <Link href={`/applications/${r.id}`} className="underline">{r.companyName} — {r.jobTitle}</Link>
                  {r.external && <span className="ml-2 rounded bg-gray-200 px-1.5 text-xs">External</span>}
                </td>
                <td>{STATUS_LABELS[r.status] ?? r.status}</td>
                <td>{r.appliedAt}</td>
                <td>{r.followUpAt ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ExternalApplicationForm onCreated={reload} />
    </div>
  );
}
