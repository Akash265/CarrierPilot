import type { InterviewPrepRow, LikelyQuestionCategory, StoredInterviewPrepSections } from "@ai-career/application-package";
import { toEvidenceView, type PitchEvidenceView } from "../applicationPitch/serializePitch";

interface GuardedView {
  supported: boolean;
  unsupportedReason: string | null;
  evidence: PitchEvidenceView[];
}

export interface InterviewPrepView {
  id: string;
  version: number;
  sections: {
    likelyQuestions: (GuardedView & { question: string; category: LikelyQuestionCategory; answerOutline: string[] })[];
    gapQuestions: (GuardedView & { question: string; requirementTerm: string; framing: string })[];
    talkingPoints: (GuardedView & { text: string })[];
    questionsToAsk: (GuardedView & { question: string })[];
  };
  gapTerms: string[];
  requiresReview: boolean;
  researchStatus: "ok" | "no_results" | "failed";
  researchedAt: string | null;
  generationModel: string;
  createdAt: string;
}

const guarded = (i: { supported: boolean; unsupportedReason: string | null; evidence: Parameters<typeof toEvidenceView>[0][] }): GuardedView => ({
  supported: i.supported,
  unsupportedReason: i.unsupportedReason,
  evidence: i.evidence.map(toEvidenceView),
});

export function toInterviewPrepView(row: InterviewPrepRow): InterviewPrepView {
  const s = row.sections as StoredInterviewPrepSections;
  return {
    id: row.id,
    version: row.version,
    sections: {
      likelyQuestions: s.likelyQuestions.map((q) => ({ question: q.question, category: q.category, answerOutline: q.answerOutline, ...guarded(q) })),
      gapQuestions: s.gapQuestions.map((q) => ({ question: q.question, requirementTerm: q.requirementTerm, framing: q.framing, ...guarded(q) })),
      talkingPoints: s.talkingPoints.map((p) => ({ text: p.text, ...guarded(p) })),
      questionsToAsk: s.questionsToAsk.map((q) => ({ question: q.question, ...guarded(q) })),
    },
    gapTerms: row.gapTermsSnapshot as string[],
    requiresReview: row.requiresReview,
    researchStatus: row.researchStatusSnapshot,
    researchedAt: row.researchedAtSnapshot === null ? null : row.researchedAtSnapshot.toISOString(),
    generationModel: row.generationModel,
    createdAt: row.createdAt.toISOString(),
  };
}
