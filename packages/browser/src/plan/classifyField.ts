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
/**
 * A sponsorship-classified label phrased with a negation/polarity marker ("without", "NOT", "Don't",
 * "no longer", "unable") reads opposite to the plain "Will you require sponsorship?" phrasing that
 * `toAction`'s Yes/No inversion assumes. Rather than guess the polarity, such a field is never filled.
 */
const SPONSORSHIP_POLARITY = /\b(?:without|not|no longer|unable)\b|n['’]t\b/i;
/** "How did you hear about us? (LinkedIn, referral, ...)" names LinkedIn as a channel, not a profile field. */
const LINKEDIN_SOURCE_EXCLUSION = /hear about|how did you (?:hear|find)|source|referr/i;

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

/**
 * Sponsorship is always-flagged already (buildFillPlan's isAlwaysFlag); this only overrides the flag reason
 * so a negated/ambiguous question is never guessed at instead of silently flagged for no reason.
 */
function withPolarityGuard(canonical: Canonical, flagReason: string | null, label: string | null): Classification {
  if (canonical === "sponsorship" && flagReason === null && label !== null && SPONSORSHIP_POLARITY.test(label)) {
    return { canonical, flagReason: "ambiguous_wording" };
  }
  return { canonical, flagReason };
}

/** Design §4.3/§4.4. Pure and deterministic; labels are untrusted page text and are only regex-tested here. */
export function classifyField(field: SnapshotField, adapter: PortalAdapter): Classification | null {
  for (const rule of adapter.standardFields) {
    if (matches(field, rule.match)) return withPolarityGuard(rule.canonical, rule.flagReason ?? null, field.label);
  }
  if (field.label !== null) {
    for (const rule of SHARED_LABEL_RULES) {
      if (!rule.pattern.test(field.label)) continue;
      if (rule.canonical === "linkedin" && LINKEDIN_SOURCE_EXCLUSION.test(field.label)) continue;
      return withPolarityGuard(rule.canonical, null, field.label);
    }
  }
  return null;
}
