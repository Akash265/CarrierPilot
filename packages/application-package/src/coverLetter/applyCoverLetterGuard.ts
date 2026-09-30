import type { CoverLetterRole, StoredCoverLetterParagraph } from "../types";
import { checkCitations, indexEvidence, toGuarded, type CitationRequirement } from "../guard/checkCitations";
import type { PitchEvidenceItem } from "../pitch/buildEvidenceIndex";
import type { CoverLetterDraft } from "./coverLetterSchema";

export const COVER_LETTER_CITATION_RULES: Record<CoverLetterRole, CitationRequirement> = {
  opening: [["requirement"]],
  company: [["research"]],
  evidence: [["profile"]],
  closing: [],
};

export interface CoverLetterGuardResult {
  paragraphs: StoredCoverLetterParagraph[];
  requiresReview: boolean;
}

/** Phase 7c design §4.2. Unsupported paragraphs are kept and flagged, never dropped. */
export function applyCoverLetterGuard(evidence: PitchEvidenceItem[], draft: CoverLetterDraft): CoverLetterGuardResult {
  const lookup = indexEvidence(evidence);
  const paragraphs: StoredCoverLetterParagraph[] = draft.paragraphs.map((p) => ({
    role: p.role,
    text: p.text,
    ...toGuarded(checkCitations(lookup, p.evidenceIds, COVER_LETTER_CITATION_RULES[p.role])),
  }));
  return { paragraphs, requiresReview: paragraphs.some((p) => p.supported === false) || draft.requiresReview };
}
