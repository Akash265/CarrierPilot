"use client";

import { useEffect, useState } from "react";
import { DownloadButtons } from "./DownloadButtons";
import { EvidenceList, type EvidenceView } from "./EvidenceList";
import type { ResearchStatus } from "./viewTypes";

interface Guarded {
  supported: boolean;
  unsupportedReason: string | null;
  evidence: EvidenceView[];
}
export interface InterviewPrepView {
  id: string;
  version: number;
  sections: {
    likelyQuestions: (Guarded & { question: string; category: "technical" | "behavioral" | "role"; answerOutline: string[] })[];
    gapQuestions: (Guarded & { question: string; requirementTerm: string; framing: string })[];
    talkingPoints: (Guarded & { text: string })[];
    questionsToAsk: (Guarded & { question: string })[];
  };
  gapTerms: string[];
  requiresReview: boolean;
  researchStatus: ResearchStatus;
  researchedAt: string | null;
  generationModel: string;
  createdAt: string;
}

// The route also returns the current research; this panel shows only each version's own snapshot status.
type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; versions: InterviewPrepView[]; selectedId: string | null };

/** Same marking as the export's buildInterviewPrepModel. */
const mark = (text: string, supported: boolean) => (supported ? text : `${text} (unverified)`);

export function formatInterviewPrepText(prep: InterviewPrepView): string {
  const s = prep.sections;
  const parts = [
    [
      "Likely questions",
      ...s.likelyQuestions.map((q) => [`- ${mark(q.question, q.supported)} (${q.category})`, ...q.answerOutline.map((a) => `  • ${a}`)].join("\n")),
    ].join("\n"),
    [
      `Required skills not found in your profile: ${prep.gapTerms.length > 0 ? prep.gapTerms.join(", ") : "none"}`,
      ...s.gapQuestions.map((q) => `- ${mark(q.question, q.supported)}\n  ${q.framing}`),
    ].join("\n"),
    ["Company talking points", ...s.talkingPoints.map((p) => `- ${mark(p.text, p.supported)}`)].join("\n"),
    ["Questions to ask", ...s.questionsToAsk.map((q) => `- ${mark(q.question, q.supported)}`)].join("\n"),
  ];
  return parts.join("\n\n");
}

function Flag({ item }: { item: Guarded }) {
  if (item.supported) return null;
  return <span className="ml-2 rounded bg-yellow-100 px-1.5 py-0.5 text-xs">unverified: {item.unsupportedReason}</span>;
}

function countUnsupported(prep: InterviewPrepView): number {
  const s = prep.sections;
  return (
    s.likelyQuestions.filter((q) => !q.supported).length +
    s.gapQuestions.filter((q) => !q.supported).length +
    s.talkingPoints.filter((p) => !p.supported).length +
    s.questionsToAsk.filter((q) => !q.supported).length
  );
}

export function InterviewPrepPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState<null | "generate">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const base = `/api/interview-preps/${encodeURIComponent(jobId)}`;

  // Same promise-chain pattern as PitchPanel: react-hooks/set-state-in-effect forbids setState calls
  // in an async function an effect invokes directly. A plain reload keeps the current selection (if it
  // still exists); only generate() passes { selectNewest: true }.
  const load = (opts: { selectNewest?: boolean; isStale?: () => boolean } = {}) =>
    fetch(base)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((body) => {
        if (opts.isStale?.()) return;
        const versions = body.versions as InterviewPrepView[];
        setState((prev) => {
          let selectedId = versions[0]?.id ?? null;
          if (!opts.selectNewest && prev.kind === "ready" && prev.selectedId !== null) {
            if (versions.some((v) => v.id === prev.selectedId)) selectedId = prev.selectedId;
          }
          return { kind: "ready", versions, selectedId };
        });
      })
      .catch(() => {
        if (opts.isStale?.()) return;
        setState({ kind: "error" });
      });

  useEffect(() => {
    let ignore = false;
    load({ isStale: () => ignore });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const post = async (
    kind: "generate",
    url: string,
    init: RequestInit,
    fallback: string,
    loadOpts: { selectNewest?: boolean } = {}
  ): Promise<boolean> => {
    setBusy(kind);
    setActionError(null);
    setCopied(false);
    try {
      const res = await fetch(url, { method: "POST", ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setActionError(body?.error ?? fallback);
        return false;
      }
      await load(loadOpts);
      return true;
    } catch {
      setActionError(fallback);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (state.kind === "loading") return <p>Loading interview prep...</p>;
  if (state.kind === "error") {
    return (
      <p role="alert" className="text-red-600">
        Could not load interview prep.{" "}
        <button type="button" onClick={() => load()} className="underline">
          Retry
        </button>
      </p>
    );
  }

  const selected = state.versions.find((v) => v.id === state.selectedId) ?? null;
  const unsupportedCount = selected ? countUnsupported(selected) : 0;

  const generate = () => post("generate", `${base}/run`, {}, "Could not generate interview prep.", { selectNewest: true });
  const copy = () => {
    if (!selected) return;
    navigator.clipboard
      .writeText(formatInterviewPrepText(selected))
      .then(() => setCopied(true))
      .catch(() => setActionError("Could not copy to the clipboard."));
  };

  return (
    <section aria-labelledby="interview-prep-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="interview-prep-heading" className="font-medium">Interview preparation</h2>
        <button
          type="button"
          onClick={generate}
          disabled={busy !== null}
          className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {busy === "generate" ? "Generating..." : selected ? "Regenerate" : "Generate Interview Prep"}
        </button>
      </div>
      {busy === "generate" && (
        <p className="text-sm text-gray-600">Preparing interview questions can take up to a minute.</p>
      )}
      {actionError && <p role="alert" className="text-sm text-red-600">{actionError}</p>}

      {selected && selected.researchStatus !== "ok" && (
        <p className="text-sm text-gray-600">Web research unavailable — company talking points are based on posting data only</p>
      )}

      {state.versions.length > 1 && (
        <label className="text-sm">
          Version:{" "}
          <select
            value={state.selectedId ?? ""}
            onChange={(e) => setState({ ...state, selectedId: e.target.value })}
            className="rounded border px-2 py-1"
          >
            {state.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version} — {new Date(v.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && selected.requiresReview && (
        <div role="alert" className="rounded border border-yellow-600 bg-yellow-50 p-3 text-sm">
          <p className="font-medium text-yellow-800">
            {unsupportedCount > 0
              ? `${unsupportedCount} item${unsupportedCount === 1 ? "" : "s"} could not be verified against your evidence; check them before relying on them.`
              : "The model flagged this pack for review."}
          </p>
        </div>
      )}

      {selected && (
        <>
          <details open className="rounded border p-2 text-sm">
            <summary className="font-medium">Likely questions</summary>
            <ul className="mt-2 flex flex-col gap-2">
              {selected.sections.likelyQuestions.map((q, i) => (
                <li key={i}>
                  <p>
                    {q.question}
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs">{q.category}</span>
                    <Flag item={q} />
                  </p>
                  <ul className="ml-4 list-disc">
                    {q.answerOutline.map((a, j) => (
                      <li key={j}>{a}</li>
                    ))}
                  </ul>
                  <EvidenceList evidence={q.evidence} />
                </li>
              ))}
            </ul>
          </details>

          <details open className="rounded border p-2 text-sm">
            <summary className="font-medium">Required skills not found in your profile</summary>
            <div className="mt-2 flex flex-col gap-2">
              {selected.gapTerms.length > 0 ? (
                <ul aria-label="Missing required terms" className="flex flex-wrap gap-2">
                  {selected.gapTerms.map((term) => (
                    <li key={term} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                      {term}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>None: every required term appears in your profile.</p>
              )}
              <ul className="flex flex-col gap-2">
                {selected.sections.gapQuestions.map((q, i) => (
                  <li key={i}>
                    <p>
                      {q.question}
                      <Flag item={q} />
                    </p>
                    {/* An unsupported gap question's term may not be missing at all, so it is not called "Missing". */}
                    <p className="text-xs text-gray-600">{q.supported ? `Missing: ${q.requirementTerm}` : `Term: ${q.requirementTerm}`}</p>
                    <p className="text-gray-600">{q.framing}</p>
                    <EvidenceList evidence={q.evidence} />
                  </li>
                ))}
              </ul>
            </div>
          </details>

          <details open className="rounded border p-2 text-sm">
            <summary className="font-medium">Company talking points</summary>
            <ul className="mt-2 flex flex-col gap-2">
              {selected.sections.talkingPoints.map((p, i) => (
                <li key={i}>
                  <p>
                    {p.text}
                    <Flag item={p} />
                  </p>
                  <EvidenceList evidence={p.evidence} />
                </li>
              ))}
            </ul>
          </details>

          <details open className="rounded border p-2 text-sm">
            <summary className="font-medium">Questions to ask</summary>
            <ul className="mt-2 flex flex-col gap-2">
              {selected.sections.questionsToAsk.map((q, i) => (
                <li key={i}>
                  <p>
                    {q.question}
                    <Flag item={q} />
                  </p>
                  <EvidenceList evidence={q.evidence} />
                </li>
              ))}
            </ul>
          </details>

          <div className="flex gap-2">
            <button type="button" onClick={copy} className="rounded border px-3 py-1.5 text-sm">
              Copy
            </button>
            {copied && <span className="self-center text-sm text-gray-600">Copied</span>}
            <DownloadButtons key={selected.id} jobId={jobId} kind="interview_prep" sourceId={selected.id} disabled={busy !== null} />
          </div>
        </>
      )}

      {!selected && <p className="text-sm text-gray-600">No interview prep generated yet for this job.</p>}
    </section>
  );
}
