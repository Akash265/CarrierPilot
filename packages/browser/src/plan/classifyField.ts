import type { Canonical, SnapshotField } from "../types";
import type { FieldMatcher, PortalAdapter } from "../adapters/types";

export interface Classification {
  canonical: Canonical;
  flagReason: string | null;
}

const EEO = /\b(?:gender|race|racial|ethnicity|hispanic|latin[oax]|veteran|disabilit(?:y|ies)|sexual orientation|pronouns?|transgender)\b/i;
const WORK_AUTHORIZATION =
  /\b(?:authori[sz]ed|authori[sz]ation|eligible|eligibility)\b[^?]*\bwork\b|\bright to work\b|\bwork permit\b|\bcitizen(?:ship)?\b|\bpermanent resident\b/i;
const SPONSORSHIP = /\b(?:require|need)\b[^?]*\bsponsor|\bsponsorship\b[^?]*\b(?:require|need)/i;
const SALARY = /\b(?:salary|compensation|pay)\b[^?]*\b(?:expect|desired|requirement)|\b(?:expected|desired)\s+(?:salary|compensation|pay)\b/i;

/** Order matters: the first match wins, so the never-filled categories are checked before fillable ones. */
const SHARED_LABEL_RULES: { canonical: Canonical; pattern: RegExp }[] = [
  { canonical: "eeo", pattern: EEO },
  { canonical: "work_authorization", pattern: WORK_AUTHORIZATION },
  { canonical: "sponsorship", pattern: SPONSORSHIP },
  { canonical: "salary_expectation", pattern: SALARY },
  { canonical: "linkedin", pattern: /linkedin/i },
  { canonical: "github", pattern: /github/i },
  { canonical: "website", pattern: /\b(?:portfolio|website|personal site|blog)\b/i },
];

const anyMatch = (patterns: RegExp[] | undefined, value: string | null): boolean =>
  value !== null && (patterns ?? []).some((p) => p.test(value));

const matches = (field: SnapshotField, m: FieldMatcher): boolean =>
  anyMatch(m.ids, field.id) || anyMatch(m.names, field.name) || anyMatch(m.labels, field.label);

/** Design §4.3/§4.4. Pure and deterministic; labels are untrusted page text and are only regex-tested here. */
export function classifyField(field: SnapshotField, adapter: PortalAdapter): Classification | null {
  for (const rule of adapter.standardFields) {
    if (matches(field, rule.match)) return { canonical: rule.canonical, flagReason: rule.flagReason ?? null };
  }
  if (field.label !== null) {
    for (const rule of SHARED_LABEL_RULES) if (rule.pattern.test(field.label)) return { canonical: rule.canonical, flagReason: null };
  }
  return null;
}
