// apps/web/src/lib/documents/exportErrors.ts
import { NextResponse } from "next/server";
import type { DocumentExportError } from "@ai-career/document-export";

const RESPONSES: Record<DocumentExportError["errorClass"], [number, string]> = {
  job_not_found: [404, "Job not found"],
  source_mismatch: [400, "That version does not belong to this job"],
  profile_changed: [409, "Your profile changed since this optimization. Regenerate it first."],
  pitch_unsupported: [409, "This pitch has an unsupported bullet. Edit or regenerate it first."],
  no_profile: [409, "Confirm your profile first"],
  storage_unavailable: [502, "Document storage is unavailable. Try again."],
  invalid_content: [500, "The document could not be generated."],
};

export function exportErrorResponse(error: DocumentExportError): NextResponse {
  const [status, message] = RESPONSES[error.errorClass];
  return NextResponse.json({ error: message }, { status });
}
