/** Format-neutral document (Phase 7b design §4.1); both renderers consume only this. */
export type DocumentBlock =
  | { type: "heading"; text: string }
  | { type: "entry"; title: string; subtitle: string | null; meta: string | null }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] };

export interface DocumentModel {
  title: string;
  contactLine: string | null;
  blocks: DocumentBlock[];
}

export type DocumentFormat = "pdf" | "docx";
export type DocumentKind = "resume" | "pitch" | "cover_letter" | "interview_prep";

/** Bump whenever either renderer's output for the same model changes (it is part of the content hash). */
export const RENDERER_VERSION = "1";
