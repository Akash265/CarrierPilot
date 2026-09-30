import type { CoverLetterRole, GapTerm } from "../types";
import { containsTerm } from "../interviewPrep/computeGapTerms";

/**
 * D101: the cover letter's citation guard cannot see a paragraph presenting a missing required skill as
 * held ("I run Kubernetes clusters" with only unrelated p: citations). Returns, index-aligned with
 * `paragraphs`, the gap terms each paragraph's text contains (boundary-aware containsTerm, D95; every
 * matching term, in gap-list order; [] when none). The opening always gets []: it may legitimately name
 * what the job asks for. A mention is not proof of a claim ("I am keen to learn Kubernetes" also
 * matches), so callers mark the letter for review rather than flagging the paragraph unsupported, and
 * store the result per paragraph (missingTermMentions, D106) so the UI can say why.
 */
export function findGapTermMentions(paragraphs: { role: CoverLetterRole; text: string }[], gapTerms: GapTerm[]): string[][] {
  return paragraphs.map((p) => {
    if (p.role === "opening") return [];
    const text = p.text.toLowerCase();
    return gapTerms.filter((g) => containsTerm(text, g.term.toLowerCase())).map((g) => g.term);
  });
}
