import type { EvidenceKind, EvidenceSnapshot } from "../types";
import { capText } from "../research/text";
import type { PitchEvidenceItem } from "../pitch/buildEvidenceIndex";

/**
 * Citation rule for one generated item. Every inner group must be satisfied by at least one cited
 * evidence item whose kind is ANY kind in that group: [["requirement"], ["profile"]] = needs a q: AND a
 * p:; [["research", "requirement"]] = needs an r: OR a q:; [] = no kind requirement (ids still validated).
 */
export type CitationRequirement = EvidenceKind[][];
export type EvidenceLookup = ReadonlyMap<string, PitchEvidenceItem>;

export interface CitationResult {
  reasons: string[];
  evidence: EvidenceSnapshot[];
}

export const KIND_LABEL: Record<EvidenceKind, string> = {
  research: "company research",
  requirement: "job requirement",
  profile: "profile evidence",
};

/** Model-supplied strings are untrusted: quote and cap them before they go into a stored reason. */
export const quoteId = (id: string) => JSON.stringify(capText(id, 60));

export function indexEvidence(evidence: PitchEvidenceItem[]): EvidenceLookup {
  return new Map(evidence.map((item) => [item.id, item]));
}

/**
 * The shared grounding backstop for pitch bullets, cover-letter paragraphs and interview-prep items
 * (Phase 7c design §4.1; extracted from Phase 7a's applyPitchGuard). The model's citations are checked
 * against the evidence index passed to THIS call: every id must exist, no id may repeat within an item,
 * and each requirement group must be satisfied. Evidence text is re-read from the index, never from the model.
 */
export function checkCitations(lookup: EvidenceLookup, evidenceIds: string[], requirement: CitationRequirement): CitationResult {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const evidence: EvidenceSnapshot[] = [];

  for (const id of evidenceIds) {
    if (seen.has(id)) {
      reasons.push(`evidence id ${quoteId(id)} is cited more than once`);
      continue;
    }
    seen.add(id);
    const item = lookup.get(id);
    if (!item) {
      reasons.push(`evidence id ${quoteId(id)} does not exist`);
      continue;
    }
    evidence.push({ id: item.id, kind: item.kind, text: item.text, sourceUrl: item.sourceUrl });
  }

  for (const group of requirement) {
    if (!evidence.some((e) => group.includes(e.kind))) {
      reasons.push(`cites no ${group.map((k) => KIND_LABEL[k]).join(" or ")}`);
    }
  }
  return { reasons, evidence };
}

export function toGuarded(result: CitationResult): { supported: boolean; unsupportedReason: string | null; evidence: EvidenceSnapshot[] } {
  return {
    supported: result.reasons.length === 0,
    unsupportedReason: result.reasons.length === 0 ? null : result.reasons.join("; "),
    evidence: result.evidence,
  };
}
