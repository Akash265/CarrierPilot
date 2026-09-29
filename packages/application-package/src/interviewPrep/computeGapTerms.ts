import type { EvidenceCatalogEntry } from "@ai-career/resume-optimization";
import { MAX_GAP_TERMS, type GapTerm } from "../types";
import type { RequirementForEvidence } from "../pitch/buildEvidenceIndex";

/**
 * Deterministic gap detection (Phase 7c design §4.3, decision 6): required job terms whose text is not
 * contained -- case-insensitive plain substring, the same rule as scoreKeywordCoverage -- in the text of
 * any profile evidence entry, formatted exactly as buildEvidenceIndex formats it ("context: text"), so
 * a term found here can never also appear in a p: evidence snapshot. job_requirements has no order
 * column, so terms are sorted (term, then id) for a stable result. Capped at MAX_GAP_TERMS.
 * Known limitation (design §9): "Postgres" in the profile does not cover "PostgreSQL" in the job.
 */
export function computeGapTerms(requirements: RequirementForEvidence[], catalog: EvidenceCatalogEntry[]): GapTerm[] {
  const haystack = catalog.map((e) => (e.context ? `${e.context}: ${e.text}` : e.text)).join("\n").toLowerCase();
  const sorted = requirements
    .filter((r) => r.requirementLevel === "required" && r.termText.trim().length > 0)
    .map((r) => ({ term: r.termText.trim(), requirementId: r.id }))
    .sort((a, b) => a.term.toLowerCase().localeCompare(b.term.toLowerCase()) || a.requirementId.localeCompare(b.requirementId));

  const seen = new Set<string>();
  const gaps: GapTerm[] = [];
  for (const candidate of sorted) {
    const key = candidate.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (haystack.includes(key)) continue;
    gaps.push(candidate);
    if (gaps.length === MAX_GAP_TERMS) break;
  }
  return gaps;
}
