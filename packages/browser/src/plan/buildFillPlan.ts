import type {
  AutofillValue, AutofillValues, Canonical, FieldAuditEntry, FillAction, FillPlan, FormSnapshot, SnapshotControl, SnapshotField,
} from "../types";
import { isNeverFill } from "../types";
import type { PortalAdapter } from "../adapters/types";
import { classifyField } from "./classifyField";

const TEXT_CONTROLS = new Set<SnapshotControl>(["text", "email", "tel", "url", "number"]);
const YES = /^yes\b/i;
const NO = /^no\b/i;

const isAlwaysFlag = (c: string): c is "sponsorship" | "salary_expectation" | "resume" =>
  c === "sponsorship" || c === "salary_expectation" || c === "resume";

function toAction(field: SnapshotField, value: AutofillValue): FillAction | { reason: string } {
  if (value.kind === "text") {
    return TEXT_CONTROLS.has(field.control)
      ? { kind: "fill", fieldKey: field.key, targetKey: field.key, text: value.text }
      : { reason: "unsupported_control" };
  }
  if (value.kind === "file") {
    return field.control === "file"
      ? { kind: "setInputFiles", fieldKey: field.key, targetKey: field.key, file: value.file }
      : { reason: "unsupported_control" };
  }
  if (field.control !== "radio_group" && field.control !== "select") return { reason: "unsupported_control" };
  const yes = field.options.filter((o) => YES.test(o.label.trim()));
  const no = field.options.filter((o) => NO.test(o.label.trim()));
  if (yes.length !== 1 || no.length !== 1) return { reason: "unrecognized_options" };
  const pick = value.value ? yes[0] : no[0];
  return field.control === "radio_group"
    ? { kind: "check", fieldKey: field.key, targetKey: pick.key }
    : { kind: "selectOption", fieldKey: field.key, targetKey: field.key, optionValue: pick.value };
}

/**
 * Design §4.4. Decides everything the worker will do to the page. A field is filled only when exactly one field
 * maps to its canonical, a value exists, and the control type fits. Everything else is audited: `flagged` when the
 * user must act (required, ambiguous, missing resume), `skipped` otherwise. Audit entries never hold values.
 */
export function buildFillPlan(snapshot: FormSnapshot, adapter: PortalAdapter, values: AutofillValues): FillPlan {
  const classified = snapshot.fields.map((field) => ({ field, cls: classifyField(field, adapter) }));
  const counts = new Map<Canonical, number>();
  for (const { cls } of classified) if (cls) counts.set(cls.canonical, (counts.get(cls.canonical) ?? 0) + 1);

  const missingForHealth = snapshot.formFound
    ? adapter.requiredCanonicals.filter((c) => counts.get(c) !== 1)
    : [...adapter.requiredCanonicals];
  const healthy = snapshot.formFound && missingForHealth.length === 0;

  const actions: FillAction[] = [];
  const audit: FieldAuditEntry[] = [];

  for (const { field, cls } of classified) {
    const canonical = cls?.canonical ?? null;
    const entry = (action: FieldAuditEntry["action"], reason: string | null, valueSource: string | null = null) =>
      audit.push({ key: field.key, label: field.label, required: field.required, canonical, action, reason, valueSource, verified: null });
    const notFilled = (reason: string) => {
      const shouldAlwaysFlag = canonical !== null && isAlwaysFlag(canonical);
      entry(shouldAlwaysFlag || field.required ? "flagged" : "skipped", reason);
    };

    if (!healthy) { entry("skipped", "health_check_failed"); continue; }
    if (!cls) { notFilled("unrecognized"); continue; }
    if (isNeverFill(cls.canonical)) { notFilled(cls.canonical === "eeo" ? "intentionally_not_filled" : "not_auto_filled"); continue; }
    if (cls.flagReason) { notFilled(cls.flagReason); continue; }
    if ((counts.get(cls.canonical) ?? 0) > 1) { entry("flagged", "ambiguous_match"); continue; }

    const value = values[cls.canonical];
    if (!value) {
      if (cls.canonical === "resume") entry("flagged", "no_resume_export");
      else notFilled("no_value");
      continue;
    }
    const action = toAction(field, value);
    if ("reason" in action) { notFilled(action.reason); continue; }
    actions.push(action);
    entry("filled", null, value.source);
  }

  return { healthy, missingForHealth: healthy ? [] : missingForHealth, actions, audit };
}
