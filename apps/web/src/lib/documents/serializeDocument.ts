// apps/web/src/lib/documents/serializeDocument.ts
import type { GeneratedDocumentRow } from "@ai-career/document-export";

export interface DocumentView {
  id: string;
  kind: "resume" | "pitch";
  format: "pdf" | "docx";
  sourceVersion: number | null;
  downloadFilename: string;
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
}

export function toDocumentView(row: GeneratedDocumentRow, sourceVersion: number | null): DocumentView {
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    sourceVersion,
    downloadFilename: row.downloadFilename,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    downloadUrl: `/api/documents/${row.id}/download`,
  };
}

export const CONTENT_TYPES: Record<"pdf" | "docx", string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** RFC 6266 / 5987: ASCII fallback plus UTF-8 filename*. The stored name is already ASCII-sanitized. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
