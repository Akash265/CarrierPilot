export type ApplicationErrorClass = "job_not_found" | "already_applied" | "document_mismatch" | "not_found" | "same_status";

/** Carries a class only -- never user text -- so it is safe to log (CLAUDE.md §9). */
export class ApplicationError extends Error {
  readonly errorClass: ApplicationErrorClass;
  constructor(errorClass: ApplicationErrorClass) {
    super(errorClass);
    this.name = "ApplicationError";
    this.errorClass = errorClass;
  }
}
