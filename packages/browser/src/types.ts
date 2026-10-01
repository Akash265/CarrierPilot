export const AUTOMATION_STATUSES = [
  "queued", "launching", "filling", "awaiting_user", "submission_detected", "abandoned", "needs_manual", "failed",
] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];
export const ACTIVE_STATUSES = ["queued", "launching", "filling", "awaiting_user"] as const satisfies readonly AutomationStatus[];
export const TERMINAL_STATUSES = ["submission_detected", "abandoned", "needs_manual", "failed"] as const satisfies readonly AutomationStatus[];
export const isActiveStatus = (s: AutomationStatus): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s);
export const isTerminalStatus = (s: AutomationStatus): boolean => (TERMINAL_STATUSES as readonly string[]).includes(s);

export const PORTALS = ["greenhouse", "lever"] as const;
export type Portal = (typeof PORTALS)[number];

/** What the in-page extractor reports for one control. Groups of radios/checkboxes become one field. */
export type SnapshotControl =
  | "text" | "email" | "tel" | "url" | "number" | "textarea" | "select"
  | "radio_group" | "checkbox_group" | "checkbox" | "file" | "combobox" | "other";

/** For radio/checkbox groups `key` is that option element's data-cp-key; for select options it is the select's key. */
export interface SnapshotOption {
  key: string;
  label: string;
  value: string;
}

/** `key` is the data-cp-key stamped on the element ("f3"), or a synthetic group key ("g9") for radio/checkbox groups. */
export interface SnapshotField {
  key: string;
  control: SnapshotControl;
  name: string | null;
  id: string | null;
  autocomplete: string | null;
  /** Untrusted page text, whitespace-collapsed, trailing "*"/"✱" removed, at most 200 chars. Only ever regex-matched. */
  label: string | null;
  required: boolean;
  options: SnapshotOption[];
}

export interface FormSnapshot {
  url: string;
  formFound: boolean;
  fields: SnapshotField[];
}

export const FILLABLE_CANONICALS = [
  "first_name", "last_name", "full_name", "email", "phone", "location", "linkedin", "resume", "cover_letter", "sponsorship", "salary_expectation",
] as const;
export type FillableCanonical = (typeof FILLABLE_CANONICALS)[number];
export const NEVER_FILL_CANONICALS = ["github", "website", "work_authorization", "eeo"] as const;
export type NeverFillCanonical = (typeof NEVER_FILL_CANONICALS)[number];
export type Canonical = FillableCanonical | NeverFillCanonical;
export const isNeverFill = (c: Canonical): c is NeverFillCanonical => (NEVER_FILL_CANONICALS as readonly string[]).includes(c);

/** `source` names where the value came from (e.g. "profile.email"); it is what the audit stores instead of the value. */
export type AutofillValue =
  | { kind: "text"; text: string; source: string }
  | { kind: "file"; file: "resume" | "cover_letter"; source: string }
  | { kind: "boolean"; value: boolean; source: string };
export type AutofillValues = Partial<Record<FillableCanonical, AutofillValue>>;

/** The only page mutations the worker can perform. There is deliberately no click/press/submit kind. */
export type FillAction =
  | { kind: "fill"; fieldKey: string; targetKey: string; text: string }
  | { kind: "selectOption"; fieldKey: string; targetKey: string; optionValue: string }
  | { kind: "check"; fieldKey: string; targetKey: string }
  | { kind: "setInputFiles"; fieldKey: string; targetKey: string; file: "resume" | "cover_letter" };

export type AuditAction = "filled" | "flagged" | "skipped";

/** Never carries a field value (CLAUDE.md §9). */
export interface FieldAuditEntry {
  key: string;
  label: string | null;
  required: boolean;
  canonical: Canonical | null;
  action: AuditAction;
  reason: string | null;
  valueSource: string | null;
  verified: boolean | null;
}

export interface FillPlan {
  healthy: boolean;
  /** Required canonicals not matched by exactly one field (empty when healthy). */
  missingForHealth: Canonical[];
  actions: FillAction[];
  audit: FieldAuditEntry[];
}
