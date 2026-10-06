import type { FormSnapshot, SnapshotControl, SnapshotField, SnapshotOption } from "../types";

const KEY_PATTERN = /^[fg]\d+$/;
const KNOWN_CONTROLS: ReadonlySet<string> = new Set<SnapshotControl>([
  "text", "email", "tel", "url", "number", "textarea", "select", "radio_group", "checkbox_group", "checkbox", "file", "combobox", "other",
]);
const MAX_FIELDS = 500;
const MAX_OPTIONS = 200;
const MAX_LABEL_CHARS = 200;

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** A nullable string property: a string value (truncated for labels) is kept; anything else becomes null. */
const truncatedLabel = (v: unknown): string | null => {
  const s = asString(v);
  return s === null ? null : s.slice(0, MAX_LABEL_CHARS);
};

function sanitizeOption(raw: unknown): SnapshotOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const key = asString(o.key);
  const label = truncatedLabel(o.label);
  const value = asString(o.value);
  if (key === null || label === null || value === null) return null;
  return { key, label, value };
}

function sanitizeField(raw: unknown): SnapshotField | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const key = asString(f.key);
  if (key === null || !KEY_PATTERN.test(key)) return null;
  const control = asString(f.control);
  if (control === null || !KNOWN_CONTROLS.has(control)) return null;

  const options: SnapshotOption[] = [];
  if (Array.isArray(f.options)) {
    for (const rawOption of f.options) {
      if (options.length >= MAX_OPTIONS) break;
      const option = sanitizeOption(rawOption);
      if (option) options.push(option);
    }
  }

  return {
    key,
    control: control as SnapshotControl,
    name: asString(f.name),
    id: asString(f.id),
    autocomplete: asString(f.autocomplete),
    label: truncatedLabel(f.label),
    required: f.required === true,
    options,
  };
}

/**
 * The page's own JS reports the snapshot shape over `page.evaluate`, which is untrusted input (CLAUDE.md §9:
 * treat external content as untrusted). No schema library is introduced for this -- every property is hand-
 * checked. A field that isn't a string where one is required, has a key that doesn't match the worker's own
 * stamped `[fg]\d+` pattern, or has an unrecognized control is dropped rather than trusted; nullable string
 * properties (name/id/autocomplete/label) fall back to null instead of dropping the whole field. Fields and
 * options are capped so a hostile/broken page can't balloon the audit. An invalid top-level shape (not an
 * object, or `url`/`formFound`/`fields` of the wrong type) returns null, which the caller treats as a failed
 * health check -- nothing is filled.
 */
export function sanitizeSnapshot(raw: unknown): FormSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as Record<string, unknown>;
  const url = asString(root.url);
  if (url === null) return null;
  if (typeof root.formFound !== "boolean") return null;
  if (!Array.isArray(root.fields)) return null;

  const fields: SnapshotField[] = [];
  for (const rawField of root.fields) {
    if (fields.length >= MAX_FIELDS) break;
    const field = sanitizeField(rawField);
    if (field) fields.push(field);
  }
  return { url, formFound: root.formFound, fields };
}
