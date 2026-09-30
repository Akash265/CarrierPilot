"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { STATUS_LABELS } from "../../../lib/applications/statusLabels";

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

const todayLocal = () => new Date().toISOString().slice(0, 10);
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

/** Records which versions were actually sent (Phase 9). Newest versions are preselected; "None" is allowed. */
export function ApplicationPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [resumeId, setResumeId] = useState("");
  const [pitchId, setPitchId] = useState("");
  const [coverLetterId, setCoverLetterId] = useState("");
  const [appliedAt, setAppliedAt] = useState(todayLocal());
  const [followUpAt, setFollowUpAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    fetch(`/api/applications/for-job/${encodeURIComponent(jobId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json() as Promise<ForJob>;
      })
      .then((data) => {
        if (ignore) return;
        setState({ kind: "ready", data });
        setResumeId(data.documentOptions.resumes[0]?.id ?? "");
        setPitchId(data.documentOptions.pitches[0]?.id ?? "");
        setCoverLetterId(data.documentOptions.coverLetters[0]?.id ?? "");
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [jobId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== "ready") return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          resumeOptimizationId: resumeId || null,
          applicationPitchId: pitchId || null,
          coverLetterId: coverLetterId || null,
          appliedAt,
          followUpAt: followUpAt || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not record the application.");
        return;
      }
      const a = body.application;
      setState({ kind: "ready", data: { ...state.data, application: { id: a.id, status: a.status, appliedAt: a.appliedAt } } });
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
            <VersionSelect label="Resume version" id="app-resume" options={state.data.documentOptions.resumes} value={resumeId} onChange={setResumeId} />
            <VersionSelect label="Pitch version" id="app-pitch" options={state.data.documentOptions.pitches} value={pitchId} onChange={setPitchId} />
            <VersionSelect label="Cover letter version" id="app-cover-letter" options={state.data.documentOptions.coverLetters} value={coverLetterId} onChange={setCoverLetterId} />
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
