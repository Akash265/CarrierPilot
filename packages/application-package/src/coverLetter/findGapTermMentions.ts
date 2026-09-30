import type { CoverLetterRole, GapTerm } from "../types";
import { containsTerm } from "../interviewPrep/computeGapTerms";

export interface GapTermMention {
  paragraphIndex: number;
  term: string;
}

/**
 * D101: the cover letter's citation guard cannot see a paragraph presenting a missing required skill as
 * held ("I run Kubernetes clusters" with only unrelated p: citations). This reports every non-opening
 * paragraph whose text contains a gap term (boundary-aware containsTerm, D95; first matching term per
 * paragraph, in gap-list order). The opening is skipped: it may legitimately name what the job asks for.
 * A mention is not proof of a claim ("I am keen to learn Kubernetes" also matches), so callers mark the
 * letter for review rather than flagging the paragraph unsupported.
 */
export function findGapTermMentions(paragraphs: { role: CoverLetterRole; text: string }[], gapTerms: GapTerm[]): GapTermMention[] {
  const mentions: GapTermMention[] = [];
  paragraphs.forEach((p, paragraphIndex) => {
    if (p.role === "opening") return;
    const text = p.text.toLowerCase();
    const hit = gapTerms.find((g) => containsTerm(text, g.term.toLowerCase()));
    if (hit) mentions.push({ paragraphIndex, term: hit.term });
  });
  return mentions;
}
