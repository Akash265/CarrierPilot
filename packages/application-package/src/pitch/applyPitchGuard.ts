import type { EvidenceKind, PitchBulletKind, StoredPitchBullet } from "../types";
import { checkCitations, indexEvidence, toGuarded } from "../guard/checkCitations";
import type { PitchEvidenceItem } from "./buildEvidenceIndex";
import type { PitchDraft } from "./pitchSchema";

export const REQUIRED_EVIDENCE_KIND: Record<PitchBulletKind, EvidenceKind> = {
  company: "research",
  role: "requirement",
  candidate: "profile",
};

export interface PitchGuardResult {
  bullets: StoredPitchBullet[];
  requiresReview: boolean;
}

/**
 * The pitch's grounding backstop (Phase 7a design §4.5), now a thin wrapper over the shared
 * checkCitations (Phase 7c design §4.1): each bullet must cite ≥1 item of its required kind. A failing
 * bullet is kept with supported=false and a reason -- never dropped -- so the user always sees three bullets.
 */
export function applyPitchGuard(evidence: PitchEvidenceItem[], draft: PitchDraft): PitchGuardResult {
  const lookup = indexEvidence(evidence);
  const bullets: StoredPitchBullet[] = draft.bullets.map((bullet) => ({
    kind: bullet.kind,
    text: bullet.text,
    ...toGuarded(checkCitations(lookup, bullet.evidenceIds, [[REQUIRED_EVIDENCE_KIND[bullet.kind]]])),
  }));
  return { bullets, requiresReview: bullets.some((b) => b.supported === false) || draft.requiresReview };
}
