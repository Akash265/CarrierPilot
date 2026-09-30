"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { STATUS_LABELS, STATUS_ORDER, TERMINAL_STATUS_SET } from "../../../lib/applications/statusLabels";
import { EventTimeline, type EventView } from "./EventTimeline";
import { LogEventForm } from "./LogEventForm";
import { EditApplicationForm } from "./EditApplicationForm";

interface ApplicationView {
  id: string;
  jobId: string | null;
  companyName: string;
  jobTitle: string;
  jobUrl: string | null;
  status: string;
  appliedAt: string;
  followUpAt: string | null;
  recruiterName: string | null;
  recruiterContact: string | null;
  salaryNotes: string | null;
  notes: string | null;
  terminalAt: string | null;
  retentionPurgedAt: string | null;
  external: boolean;
  snapshotSummary: { matchOverall: number | null; atsOverall: number | null; documents: { resume: number | null; pitch: number | null; coverLetter: number | null } };
}
type State = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ready"; application: ApplicationView; events: EventView[] };

// Defense in depth: jobUrl ultimately comes from ingested job-source content (untrusted). The server
// already refuses to store a non-http(s) URL (createApplication.ts), but never render one as a link either.
const HTTP_URL_RE = /^https?:\/\//i;

export function ApplicationDetailClient({
  id,
  retentionDays,
  confirm = (message: string) => window.confirm(message),
  navigate = (url: string) => window.location.assign(url),
}: {
  id: string;
  retentionDays: number;
  confirm?: (message: string) => boolean;
  navigate?: (url: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [nextStatus, setNextStatus] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    fetch(`/api/applications/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (res.status === 404) return { kind: "missing" } as State;
        if (!res.ok) throw new Error("load failed");
        const body = await res.json();
        return { kind: "ready", application: body.application, events: body.events } as State;
      })
      .then((next) => {
        if (!ignore) setState(next);
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [id, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "missing") return <p>Application not found. <Link href="/applications" className="underline">All applications</Link></p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load this application.</p>;

  const { application: a, events } = state;
  const summary = a.snapshotSummary;
  const docs = [
    summary.documents.resume !== null && `Resume v${summary.documents.resume}`,
    summary.documents.pitch !== null && `Pitch v${summary.documents.pitch}`,
    summary.documents.coverLetter !== null && `Cover letter v${summary.documents.coverLetter}`,
  ].filter(Boolean) as string[];

  const updateStatus = async () => {
    if (!nextStatus || nextStatus === a.status) return;
    const enteringTerminal = TERMINAL_STATUS_SET.has(nextStatus) && !TERMINAL_STATUS_SET.has(a.status);
    if (enteringTerminal && a.jobId && retentionDays > 0 &&
        !confirm(`Documents generated for this job will be deleted ${retentionDays} days after this status. Continue?`)) {
      return;
    }
    setActionError(null);
    try {
      const res = await fetch(`/api/applications/${a.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toStatus: nextStatus }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setActionError(typeof b.error === "string" ? b.error : "Could not update the status.");
        return;
      }
      setNextStatus("");
      reload();
    } catch {
      setActionError("Could not update the status.");
    }
  };

  const remove = async () => {
    if (!confirm("Delete this application and its timeline? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/applications/${a.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("failed");
      navigate("/applications");
    } catch {
      setActionError("Could not delete the application.");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Link href="/applications" className="text-sm underline">← All applications</Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{a.companyName} — {a.jobTitle}</h1>
        <p className="text-sm text-gray-600">
          {STATUS_LABELS[a.status] ?? a.status} · applied {a.appliedAt}
          {a.external && " · External"}
          {a.jobUrl && HTTP_URL_RE.test(a.jobUrl) && <> · <a href={a.jobUrl} target="_blank" rel="noopener noreferrer" className="underline">Posting</a></>}
        </p>
        {(summary.matchOverall !== null || summary.atsOverall !== null) && (
          <p className="text-sm text-gray-600">
            Match {summary.matchOverall ?? "—"} · ATS {summary.atsOverall ?? "—"} at time of applying
          </p>
        )}
      </header>

      <section aria-labelledby="status-heading" className="flex flex-wrap items-end gap-2 text-sm">
        <h2 id="status-heading" className="w-full font-medium">Status</h2>
        <label className="flex flex-col gap-1">
          New status
          <select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} className="rounded border p-1">
            <option value="">Choose...</option>
            {STATUS_ORDER.filter((s) => s !== a.status).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <button type="button" onClick={updateStatus} className="rounded bg-black px-3 py-1.5 text-white">Update status</button>
        {actionError && <p role="alert" className="w-full text-red-600">{actionError}</p>}
      </section>

      {!a.external && (
        <section aria-labelledby="sent-heading" className="text-sm">
          <h2 id="sent-heading" className="mb-1 font-medium">Documents sent</h2>
          {a.retentionPurgedAt ? (
            <p>Documents deleted after the retention period.</p>
          ) : (
            <>
              <p>{docs.length > 0 ? docs.join(" · ") : "None recorded"}</p>
              {a.jobId && <Link href={`/matches/${a.jobId}`} className="underline">Open job workspace</Link>}
            </>
          )}
        </section>
      )}

      <EditApplicationForm key={reloadKey} applicationId={a.id} initial={a} onSaved={reload} />
      <EventTimeline events={events} />
      <LogEventForm applicationId={a.id} onLogged={reload} />

      <button type="button" onClick={remove} className="self-start text-sm text-red-700 underline">Delete application</button>
    </div>
  );
}
