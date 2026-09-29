"use client";

import { useEffect, useState } from "react";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

interface DocumentView {
  id: string;
  kind: "resume" | "pitch";
  format: "pdf" | "docx";
  sourceVersion: number | null;
  downloadFilename: string;
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
}

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; documents: DocumentView[] };

export function DocumentsList({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let ignore = false;
    // Promise chain (state set in callbacks), matching the other panels' react-hooks/set-state-in-effect pattern.
    const load = () =>
      fetch(`/api/documents?jobId=${encodeURIComponent(jobId)}`)
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body) => {
          if (!ignore) setState({ kind: "ready", documents: body.documents as DocumentView[] });
        })
        .catch(() => {
          if (!ignore) setState({ kind: "error" });
        });
    load();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, load);
    return () => {
      ignore = true;
      window.removeEventListener(DOCUMENTS_CHANGED_EVENT, load);
    };
  }, [jobId]);

  return (
    <section aria-labelledby="documents-heading" className="flex flex-col gap-2">
      <h2 id="documents-heading" className="font-medium">Documents</h2>
      {state.kind === "loading" && <p className="text-sm text-gray-600">Loading documents...</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-red-600">Could not load documents.</p>}
      {state.kind === "ready" && state.documents.length === 0 && (
        <p className="text-sm text-gray-600">No documents exported yet.</p>
      )}
      {state.kind === "ready" && state.documents.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {state.documents.map((d) => (
            <li key={d.id}>
              {d.kind === "resume" ? "Resume" : "Pitch"} v{d.sourceVersion ?? "?"} · {d.format.toUpperCase()} ·{" "}
              {new Date(d.createdAt).toLocaleString()} ·{" "}
              <a href={d.downloadUrl} className="underline">Download</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
