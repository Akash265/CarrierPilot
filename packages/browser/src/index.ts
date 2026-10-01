export * from "./types";
export * from "./queue";
export { AutomationError, type AutomationErrorClass } from "./errors";
export {
  greenhouseV1, leverV1, getAdapter, SAFE_IDENTIFIER,
  type PortalAdapter, type SnapshotConfig, type StandardFieldRule, type FieldMatcher, type FormUrlInput,
} from "./adapters";
export { resolveAutofillTarget, type PostingRef, type AutofillTarget, type UnsupportedReason } from "./adapters/resolveAutofillTarget";
export { detectSubmission } from "./detect/detectSubmission";
export { EXTRACT_SNAPSHOT_SOURCE } from "./snapshot/extractSnapshotSource";
