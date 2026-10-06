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
export { sanitizeSnapshot } from "./snapshot/sanitizeSnapshot";
export { buildAutofillValues, type AutofillInput } from "./values/buildAutofillValues";
export { classifyField, type Classification } from "./plan/classifyField";
export { buildFillPlan } from "./plan/buildFillPlan";
export { getAutofillSupport, type AutofillSupport } from "./sessions/support";
export { createSession, type SessionRow } from "./sessions/createSession";
export {
  transitionSession, failSession, requestCancel, isCancelRequested, sweepInterruptedSessions, type TransitionPatch,
} from "./sessions/transitions";
export { getSession, getJobAutofillOverview, type JobAutofillOverview } from "./sessions/readSessions";
export { loadAutofillContext, type AutofillContext, type StoredDocumentRef } from "./sessions/loadAutofillContext";
