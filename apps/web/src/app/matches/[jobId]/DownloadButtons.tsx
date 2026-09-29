"use client";

import { useState } from "react";

export const DOCUMENTS_CHANGED_EVENT = "documents:changed";

type Format = "pdf" | "docx";

export function DownloadButtons({
  jobId,
  kind,
  sourceId,
  disabled = false,
  navigate = (url: string) => window.location.assign(url),
}: {
  jobId: string;
  kind: "resume" | "pitch";
  sourceId: string;
  disabled?: boolean;
  navigate?: (url: string) => void;
}) {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportAs = async (format: Format) => {
    setBusy(format);
    setError(null);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, jobId, sourceId, format }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not export the document.");
        return;
      }
      window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT));
      navigate(body.document.downloadUrl as string);
    } catch {
      setError("Could not export the document.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {(["pdf", "docx"] as const).map((format) => (
          <button
            key={format}
            type="button"
            onClick={() => exportAs(format)}
            disabled={disabled || busy !== null}
            className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {busy === format ? "Exporting..." : `Download ${format.toUpperCase()}`}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
