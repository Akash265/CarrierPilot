import type { GapTerm, StoredGapQuestion, StoredInterviewPrepSections } from "../types";
import { checkCitations, indexEvidence, quoteId, toGuarded } from "../guard/checkCitations";
import { containsTerm } from "./computeGapTerms";
import type { PitchEvidenceItem } from "../pitch/buildEvidenceIndex";
import type { InterviewPrepDraft } from "./interviewPrepSchema";

export interface InterviewPrepGuardResult {
  sections: StoredInterviewPrepSections;
  requiresReview: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Phase 7c design §4.3: the shared citation rules per section plus the gap rules. Unsupported items
 * are kept and flagged, never dropped. The model's requiresReview can add caution, never remove it.
 */
export function applyInterviewPrepGuard(evidence: PitchEvidenceItem[], gapTerms: GapTerm[], draft: InterviewPrepDraft): InterviewPrepGuardResult {
  const lookup = indexEvidence(evidence);
  const gapsByKey = new Map(gapTerms.map((g) => [norm(g.term), g]));
  const usedGapKeys = new Set<string>();

  const gapQuestions: StoredGapQuestion[] = draft.gapQuestions.map((q) => {
    const result = checkCitations(lookup, q.evidenceIds, [["requirement"]]);
    const key = norm(q.requirementTerm);
    const gap = gapsByKey.get(key);
    let requirementTerm = q.requirementTerm;
    if (!gap) {
      result.reasons.push(`requirementTerm ${quoteId(q.requirementTerm)} is not one of the missing required terms`);
    } else if (usedGapKeys.has(key)) {
      result.reasons.push(`requirementTerm ${quoteId(q.requirementTerm)} already has a gap question`);
    } else {
      requirementTerm = gap.term;
      // First-use-wins: the term is only reserved once a gap question actually cites its own
      // requirement id, so an earlier bad attempt never blocks a later correct one for the same term.
      if (q.evidenceIds.includes(`q:${gap.requirementId}`)) {
        usedGapKeys.add(key);
      } else {
        result.reasons.push("does not cite the requirement it probes");
      }
      if (result.evidence.some((e) => e.kind === "profile" && containsTerm(e.text.toLowerCase(), key))) {
        result.reasons.push(`cites profile evidence that contains the missing term ${quoteId(gap.term)}`);
      }
    }
    return { question: q.question, requirementTerm, framing: q.framing, ...toGuarded(result) };
  });

  const gapTermKey = (question: string, answerOutline: string[], evidenceIds: string[]): GapTerm | undefined =>
    gapTerms.find((g) => {
      const key = g.term.toLowerCase();
      if (evidenceIds.includes(`q:${g.requirementId}`)) return true;
      if (containsTerm(question.toLowerCase(), key)) return true;
      return answerOutline.some((line) => containsTerm(line.toLowerCase(), key));
    });

  const sections: StoredInterviewPrepSections = {
    likelyQuestions: draft.likelyQuestions.map((q) => {
      const result = checkCitations(lookup, q.evidenceIds, [["requirement"], ["profile"]]);
      const targeted = gapTermKey(q.question, q.answerOutline, q.evidenceIds);
      if (targeted) result.reasons.push(`targets a missing required term ${quoteId(targeted.term)}; use a gap question`);
      return { question: q.question, category: q.category, answerOutline: q.answerOutline, ...toGuarded(result) };
    }),
    gapQuestions,
    talkingPoints: draft.talkingPoints.map((p) => ({ text: p.text, ...toGuarded(checkCitations(lookup, p.evidenceIds, [["research"]])) })),
    questionsToAsk: draft.questionsToAsk.map((q) => ({
      question: q.question,
      ...toGuarded(checkCitations(lookup, q.evidenceIds, [["research", "requirement"]])),
    })),
  };

  const all = [...sections.likelyQuestions, ...sections.gapQuestions, ...sections.talkingPoints, ...sections.questionsToAsk];
  return { sections, requiresReview: all.some((i) => !i.supported) || draft.requiresReview };
}
