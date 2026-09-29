import type { CoverLetterRow, CoverLetterRole, StoredCoverLetterParagraph } from "@ai-career/application-package";
import { toEvidenceView, type PitchEvidenceView } from "../applicationPitch/serializePitch";

export interface CoverLetterParagraphView {
  role: CoverLetterRole;
  text: string;
  supported: boolean | null;
  unsupportedReason: string | null;
  evidence: PitchEvidenceView[];
}

export interface CoverLetterView {
  id: string;
  version: number;
  origin: "generated" | "user_edited";
  parentCoverLetterId: string | null;
  paragraphs: CoverLetterParagraphView[];
  requiresReview: boolean;
  researchStatus: "ok" | "no_results" | "failed";
  researchedAt: string | null;
  generationModel: string | null;
  createdAt: string;
}

export function toCoverLetterView(row: CoverLetterRow): CoverLetterView {
  return {
    id: row.id,
    version: row.version,
    origin: row.origin,
    parentCoverLetterId: row.parentCoverLetterId,
    paragraphs: (row.paragraphs as StoredCoverLetterParagraph[]).map((p) => ({
      role: p.role, text: p.text, supported: p.supported, unsupportedReason: p.unsupportedReason, evidence: p.evidence.map(toEvidenceView),
    })),
    requiresReview: row.requiresReview,
    researchStatus: row.researchStatusSnapshot,
    researchedAt: row.researchedAtSnapshot === null ? null : row.researchedAtSnapshot.toISOString(),
    generationModel: row.generationModel,
    createdAt: row.createdAt.toISOString(),
  };
}
