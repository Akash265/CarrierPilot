export type ApplicationGenerationErrorClass = "no_match" | "not_eligible" | "no_profile" | "unknown";

/**
 * The one expected-failure class for every application-package generation (pitch, cover letter,
 * interview prep). Routes map errorClass to 404/400/409/502 (D57 for "unknown").
 */
export class ApplicationGenerationError extends Error {
  readonly errorClass: ApplicationGenerationErrorClass;
  constructor(errorClass: ApplicationGenerationErrorClass) {
    super(errorClass);
    this.name = "ApplicationGenerationError";
    this.errorClass = errorClass;
  }
}
