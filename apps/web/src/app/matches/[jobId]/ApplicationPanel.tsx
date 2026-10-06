"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { STATUS_LABELS } from "../../../lib/applications/statusLabels";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";
import { APPLICATION_RECORDED_EVENT } from "./AutofillPanel";

interface DocumentOption {
  id: string;
  version: number;
  origin: "generated" | "user_edited" | null;
}
interface ForJob {
  application: { id: string; status: string; appliedAt: string } | null;
  documentOptions: { resumes: DocumentOption[]; pitches: DocumentOption[]; coverLetters: DocumentOption[] };
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: ForJob };

type DocKind = keyof ForJob["documentOptions"];
/** An absent key means "follow the newest version"; a present key is the user's explicit pick ("" = None). */
type Choices = Partial<Record<DocKind, string>>;

const todayUtc = () => new Date().toISOString().slice(0, 10);
/** Options arrive newest-first (server ordering). A pick that no longer exists falls back to the newest. */
const resolveChoice = (options: DocumentOption[], choice: string | undefined): string =>
  choice !== undefined && (choice === "" || options.some((o) => o.id === choice)) ? choice : (options[0]?.id ?? "");

async function fetchForJob(jobId: string): Promise<ForJob> {
  const res = await fetch(`/api/applications/for-job/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error("load failed");
  return (await res.json()) as ForJob;
}
const optionLabel = (o: DocumentOption) => `v${o.version}${o.origin === "user_edited" ? " (edited)" : ""}`;

function VersionSelect({ label, id, options, value, onChange }: {
  label: string; id: string; options: DocumentOption[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="rounded border p-1">
        <option value="">None</option>
        {options.map((o) => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}
      </select>
    </label>
  );
}

/** Records which versions were actually sent (Phase 9). Newest versions are preselected (and kept current); "None" is allowed. */
export function ApplicationPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [choices, setChoices] = useState<Choices>({});
  const [appliedAt, setAppliedAt] = useState(todayUtc());
  const [followUpAt, setFollowUpAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set right before this panel dispatches APPLICATION_RECORDED_EVENT itself (in `submit`, below) so its own
  // listener here doesn't immediately redo the fetch it already has the answer to from the POST response.
  const justRecordedRef = useRef(false);

  // Options are re-fetched on mount, when a document is generated/edited/exported on this page
  // (DOCUMENTS_CHANGED_EVENT), when an autofill session is recorded as applied (APPLICATION_RECORDED_EVENT,
  // Phase 8, dispatched by AutofillPanel or by this panel's own successful submit below) and when the window
  // regains focus, so the defaults track the newest versions.
  useEffect(() => {
    let ignore = false;
    const load = () => {
      if (justRecordedRef.current) {
        justRecordedRef.current = false;
        return;
      }
      fetchForJob(jobId)
        .then((data) => {
          if (!ignore) setState({ kind: "ready", data });
        })
        .catch(() => {
          // A failed background refresh keeps the last good data; only the first load shows the error.
          if (!ignore) setState((prev) => (prev.kind === "ready" ? prev : { kind: "error" }));
        });
    };
    load();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, load);
    window.addEventListener(APPLICATION_RECORDED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      ignore = true;
      window.removeEventListener(DOCUMENTS_CHANGED_EVENT, load);
      window.removeEventListener(APPLICATION_RECORDED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [jobId]);

  const choose = (kind: DocKind) => (value: string) => setChoices((prev) => ({ ...prev, [kind]: value }));
  const selected = (kind: DocKind) => (state.kind === "ready" ? resolveChoice(state.data.documentOptions[kind], choices[kind]) : "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== "ready") return;
    setSubmitting(true);
    setError(null);
    try {
      // Re-fetch right before submitting: feature_snapshot is write-once, so stale options must not be sent.
      const fresh = await fetchForJob(jobId);
      setState({ kind: "ready", data: fresh });
      if (fresh.application) return;
      const opts = fresh.documentOptions;
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          resumeOptimizationId: resolveChoice(opts.resumes, choices.resumes) || null,
          applicationPitchId: resolveChoice(opts.pitches, choices.pitches) || null,
          coverLetterId: resolveChoice(opts.coverLetters, choices.coverLetters) || null,
          appliedAt,
          followUpAt: followUpAt || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 means another tab (or request) already recorded the application: reload and switch to
        // the applied state instead of just showing the error. If the reload fails or still finds
        // nothing, fall through and show the server's error message.
        if (res.status === 409) {
          try {
            const after = await fetchForJob(jobId);
            if (after.application) {
              setState({ kind: "ready", data: after });
              return;
            }
          } catch {
            // reload failed; fall through to show the server's error message
          }
        }
        setError(typeof body.error === "string" ? body.error : "Could not record the application.");
        return;
      }
      const a = body.application;
      setState({ kind: "ready", data: { ...fresh, application: { id: a.id, status: a.status, appliedAt: a.appliedAt } } });
      // So AutofillPanel reloads too: once this job has an application, its "Record as applied" button
      // must stop offering a session link that would now 409 (Phase 8). justRecordedRef makes this panel's
      // own listener (above) skip the redundant refetch it has no need for.
      justRecordedRef.current = true;
      window.dispatchEvent(new Event(APPLICATION_RECORDED_EVENT));
    } catch {
      setError("Could not record the application.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="application-heading" className="flex flex-col gap-2 rounded border p-4">
      <h2 id="application-heading" className="font-medium">Application</h2>
      {state.kind === "loading" && <p className="text-sm text-gray-600">Loading...</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-red-600">Could not load the application status.</p>}
      {state.kind === "ready" && state.data.application && (
        <div className="flex items-center gap-3 text-sm">
          <p>Applied on {state.data.application.appliedAt} · {STATUS_LABELS[state.data.application.status] ?? state.data.application.status}</p>
          <Link href={`/applications/${state.data.application.id}`} className="underline">Open in tracker</Link>
        </div>
      )}
      {state.kind === "ready" && !state.data.application && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-sm text-gray-600">Record which versions you sent. They are kept with the application.</p>
          <div className="grid grid-cols-3 gap-3">
            <VersionSelect label="Resume version" id="app-resume" options={state.data.documentOptions.resumes} value={selected("resumes")} onChange={choose("resumes")} />
            <VersionSelect label="Pitch version" id="app-pitch" options={state.data.documentOptions.pitches} value={selected("pitches")} onChange={choose("pitches")} />
            <VersionSelect label="Cover letter version" id="app-cover-letter" options={state.data.documentOptions.coverLetters} value={selected("coverLetters")} onChange={choose("coverLetters")} />
          </div>
          <div className="flex gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Applied on
              <input type="date" value={appliedAt} onChange={(e) => setAppliedAt(e.target.value)} required className="rounded border p-1" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Follow-up date (optional)
              <input type="date" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} className="rounded border p-1" />
            </label>
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="self-start rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {submitting ? "Saving..." : "Mark as applied"}
          </button>
        </form>
      )}
    </section>
  );
}
