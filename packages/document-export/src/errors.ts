export type DocumentExportErrorClass =
  | "job_not_found"
  | "source_mismatch"
  | "profile_changed"
  | "pitch_unsupported"
  | "no_profile"
  | "invalid_content"
  | "storage_unavailable";

export class DocumentExportError extends Error {
  readonly errorClass: DocumentExportErrorClass;
  constructor(errorClass: DocumentExportErrorClass, options?: { cause?: unknown }) {
    super(errorClass, options);
    this.name = "DocumentExportError";
    this.errorClass = errorClass;
  }
}
