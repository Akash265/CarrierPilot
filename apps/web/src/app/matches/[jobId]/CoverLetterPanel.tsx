"use client";

import { useEffect, useState } from "react";
import { DownloadButtons } from "./DownloadButtons";
import { EvidenceList, type EvidenceView } from "./EvidenceList";

type ParagraphRole = "opening" | "company" | "evidence" | "closing";
type ResearchStatus = "ok" | "no_results" | "failed";

interface ParagraphView {
  role: ParagraphRole;
  text: string;
  supported: boolean | null;
  unsupportedReason: string | null;
  evidence: EvidenceView[];
}
interface CoverLetterView {
  id: string;
  version: number;
  origin: "generated" | "user_edited";
  parentCoverLetterId: string | null;
  paragraphs: ParagraphView[];
  requiresReview: boolean;
  researchStatus: ResearchStatus;
  researchedAt: string | null;
  generationModel: string | null;
  createdAt: string;
}
interface ResearchView {
  id: string;
  companyName: string;
  status: ResearchStatus;
  researchedAt: string;
  searchCount: number;
}

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; versions: CoverLetterView[]; research: ResearchView | null; selectedId: string | null };

const ROLE_LABELS: Record<ParagraphRole, string> = {
  opening: "Opening",
  company: "Why this company",
  evidence: "Evidence of fit",
  closing: "Closing",
};

/** Edit-mode label: two evidence paragraphs become "Evidence of fit 1" / "Evidence of fit 2" so each textarea has a unique name. */
function editLabel(paragraphs: { role: ParagraphRole }[], index: number): string {
  const role = paragraphs[index].role;
  const sameRole = paragraphs.filter((p) => p.role === role);
  if (sameRole.length < 2) return ROLE_LABELS[role];
  return `${ROLE_LABELS[role]} ${paragraphs.slice(0, index + 1).filter((p) => p.role === role).length}`;
}

export function CoverLetterPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState<null | "generate" | "save">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const base = `/api/cover-letters/${encodeURIComponent(jobId)}`;

  // Same promise-chain pattern as PitchPanel: react-hooks/set-state-in-effect forbids setState calls
  // in an async function an effect invokes directly. A plain reload keeps the current selection (if it
  // still exists); only generate() and a successful save() pass { selectNewest: true }.
  const load = (opts: { selectNewest?: boolean; isStale?: () => boolean } = {}) =>
    fetch(base)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((body) => {
        if (opts.isStale?.()) return;
        const versions = body.versions as CoverLetterView[];
        const research = (body.research as ResearchView | null) ?? null;
        setState((prev) => {
          let selectedId = versions[0]?.id ?? null;
          if (!opts.selectNewest && prev.kind === "ready" && prev.selectedId !== null) {
            if (versions.some((v) => v.id === prev.selectedId)) selectedId = prev.selectedId;
          }
          return { kind: "ready", versions, research, selectedId };
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
    kind: "generate" | "save",
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

  if (state.kind === "loading") return <p>Loading cover letter...</p>;
  if (state.kind === "error") {
    return (
      <p role="alert" className="text-red-600">
        Could not load the cover letter.{" "}
        <button type="button" onClick={() => load()} className="underline">
          Retry
        </button>
      </p>
    );
  }

  const selected = state.versions.find((v) => v.id === state.selectedId) ?? null;
  const unsupported = selected?.paragraphs.filter((p) => p.supported === false) ?? [];

  const generate = () => post("generate", `${base}/run`, {}, "Could not generate a cover letter.", { selectNewest: true });
  const save = async () => {
    if (!selected || !draft) return;
    const ok = await post(
      "save",
      `${base}/edit`,
      { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersionId: selected.id, paragraphs: draft }) },
      "Could not save your edit.",
      { selectNewest: true }
    );
    if (ok) setDraft(null);
  };
  const copy = () => {
    if (!selected) return;
    navigator.clipboard
      .writeText(selected.paragraphs.map((p) => p.text).join("\n\n"))
      .then(() => setCopied(true))
      .catch(() => setActionError("Could not copy to the clipboard."));
  };

  return (
    <section aria-labelledby="cover-letter-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="cover-letter-heading" className="font-medium">Cover letter</h2>
        <button
          type="button"
          onClick={generate}
          disabled={busy !== null || draft !== null}
          className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {busy === "generate" ? "Generating..." : selected ? "Regenerate" : "Generate Cover Letter"}
        </button>
      </div>
      <p className="text-sm text-gray-600">
        Optional: use it only if the application asks for one. The hiring manager pitch is the primary document.
      </p>
      {busy === "generate" && (
        <p className="text-sm text-gray-600">Researching a company for the first time can take up to a minute.</p>
      )}
      {actionError && <p role="alert" className="text-sm text-red-600">{actionError}</p>}

      {selected && selected.researchStatus !== "ok" && (
        <p className="text-sm text-gray-600">Web research unavailable — the company paragraph is based on posting data only</p>
      )}

      {state.versions.length > 1 && (
        <label className="text-sm">
          Version:{" "}
          <select
            value={state.selectedId ?? ""}
            onChange={(e) => {
              setDraft(null);
              setState({ ...state, selectedId: e.target.value });
            }}
            className="rounded border px-2 py-1"
          >
            {state.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version} · {v.origin === "user_edited" ? "edited" : "generated"} — {new Date(v.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && selected.requiresReview && (
        <div role="alert" className="rounded border border-yellow-600 bg-yellow-50 p-3 text-sm">
          <p className="font-medium text-yellow-800">Review needed</p>
          {unsupported.length > 0 ? (
            <ul>
              {unsupported.map((p, i) => (
                <li key={i}>{ROLE_LABELS[p.role]}: {p.unsupportedReason}</li>
              ))}
            </ul>
          ) : (
            <p>The model flagged this cover letter for review.</p>
          )}
        </div>
      )}

      {selected && draft === null && (
        <>
          <ol className="flex flex-col gap-2">
            {selected.paragraphs.map((p, i) => (
              <li key={i} className="rounded border p-2 text-sm">
                <p className="text-xs font-medium uppercase text-gray-600">
                  {ROLE_LABELS[p.role]}
                  {p.supported === null && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 normal-case">your wording</span>}
                  {p.supported === false && <span className="ml-2 rounded bg-yellow-100 px-1.5 py-0.5 normal-case">unsupported</span>}
                </p>
                <p className="whitespace-pre-wrap">{p.text}</p>
                <EvidenceList evidence={p.evidence} />
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <button type="button" onClick={() => setDraft(selected.paragraphs.map((p) => p.text))} disabled={busy !== null} className="rounded border px-3 py-1.5 text-sm">
              Edit
            </button>
            <button type="button" onClick={copy} className="rounded border px-3 py-1.5 text-sm">
              Copy
            </button>
            {copied && <span className="self-center text-sm text-gray-600">Copied</span>}
            <DownloadButtons key={selected.id} jobId={jobId} kind="cover_letter" sourceId={selected.id} disabled={busy !== null} />
          </div>
        </>
      )}

      {selected && draft !== null && (
        <div className="flex flex-col gap-2">
          {selected.paragraphs.map((p, i) => (
            <label key={i} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{editLabel(selected.paragraphs, i)}</span>
              <textarea
                aria-label={editLabel(selected.paragraphs, i)}
                value={draft[i]}
                maxLength={1200}
                rows={5}
                onChange={(e) => setDraft(draft.map((d, j) => (j === i ? e.target.value : d)))}
                className="rounded border p-2"
              />
            </label>
          ))}
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy !== null} className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">
              {busy === "save" ? "Saving..." : "Save as new version"}
            </button>
            <button type="button" onClick={() => setDraft(null)} disabled={busy !== null} className="rounded border px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!selected && <p className="text-sm text-gray-600">No cover letter generated yet for this job.</p>}
    </section>
  );
}
