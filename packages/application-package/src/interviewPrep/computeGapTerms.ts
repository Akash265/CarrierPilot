import type { EvidenceCatalogEntry } from "@ai-career/resume-optimization";
import type { GapTerm } from "../types";
import type { RequirementForEvidence } from "../pitch/buildEvidenceIndex";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `termLower` occurs in `haystackLower` with no [a-z0-9] character immediately before or
 * after it -- a boundary-aware match, deliberately stricter than a plain substring so short terms
 * ("Go", "C") are not hidden inside longer words ("Google", "C++" would still match itself, but "Go"
 * inside "Google" would not). Both arguments are expected to already be lowercased.
 */
export function containsTerm(haystackLower: string, termLower: string): boolean {
  const escaped = escapeRegExp(termLower);
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystackLower);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Deterministic gap detection (Phase 7c design §4.3, decision 6): required job terms whose text is not
 * contained -- boundary-aware match (deliberately stricter than scoreKeywordCoverage's substring rule
 * so short terms like "Go" are not hidden by "Google") -- in the text of any profile evidence entry,
 * formatted exactly as buildEvidenceIndex formats it ("context: text"), so a term found here can never
 * also appear in a p: evidence snapshot. job_requirements has no order column, so terms are sorted
 * (term, then id, by plain code-unit comparison for stability across environments) for a stable result.
 * Returns EVERY missing required term (no cap, D100): callers that feed the model slice the first
 * MAX_GAP_TERMS themselves, while the likely-question gap check and the stored snapshot use all of them.
 * Known limitations (design §9, D92): "Postgres" in the profile does not cover "PostgreSQL" in the job,
 * and a phrase-shaped required term ("Production data pipeline building experience") is almost never
 * contained verbatim in profile text, so it becomes a false gap.
 */
export function computeGapTerms(requirements: RequirementForEvidence[], catalog: EvidenceCatalogEntry[]): GapTerm[] {
  const haystack = catalog.map((e) => (e.context ? `${e.context}: ${e.text}` : e.text)).join("\n").toLowerCase();
  const sorted = requirements
    .filter((r) => r.requirementLevel === "required" && r.termText.trim().length > 0)
    .map((r) => ({ term: r.termText.trim(), requirementId: r.id }))
    .sort((a, b) => compareStrings(a.term.toLowerCase(), b.term.toLowerCase()) || compareStrings(a.requirementId, b.requirementId));

  const seen = new Set<string>();
  const gaps: GapTerm[] = [];
  for (const candidate of sorted) {
    const key = candidate.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (containsTerm(haystack, key)) continue;
    gaps.push(candidate);
  }
  return gaps;
}
