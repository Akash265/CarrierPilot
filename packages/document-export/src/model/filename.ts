import type { DocumentFormat, DocumentKind } from "./types";

const MAX_BASE = 120;

/** ASCII-only, filesystem- and header-safe download name (the real key in storage is generated). */
export function sanitizeFilename(base: string, extension: DocumentFormat): string {
  const cleaned = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 .,_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BASE)
    .trim();
  const safe = cleaned.replace(/^[.\s]+/, "");
  return `${safe.length > 0 ? safe : "document"}.${extension}`;
}

export function buildDownloadFilename(fullName: string, companyName: string, kind: DocumentKind, format: DocumentFormat): string {
  return sanitizeFilename(`${fullName} - ${companyName} - ${kind === "resume" ? "Resume" : "Pitch"}`, format);
}
