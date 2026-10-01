export type AutomationErrorClass =
  | "job_not_found" | "profile_missing" | "unsupported" | "session_active" | "not_found" | "not_cancellable";

/** Carries a class (and for `unsupported` a fixed reason code) only -- never user or page text -- so it is safe to log. */
export class AutomationError extends Error {
  readonly errorClass: AutomationErrorClass;
  readonly detail: string | null;
  constructor(errorClass: AutomationErrorClass, detail: string | null = null) {
    super(errorClass);
    this.name = "AutomationError";
    this.errorClass = errorClass;
    this.detail = detail;
  }
}
