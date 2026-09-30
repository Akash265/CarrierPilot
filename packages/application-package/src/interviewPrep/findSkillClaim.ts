import { containsTerm } from "./computeGapTerms";

/**
 * First- or second-person phrasing that asserts experience. A match immediately followed by "not",
 * "never" or "no" ("you have not used", "you've never used") is not a claim.
 */
const CLAIM_PATTERN =
  /\b(?:I have|I've|my experience (?:with|in)|I am experienced|extensive|you have|you've|your (?:experience|background) (?:with|in)|you already|this is actually a strength)\b(?!\s+(?:not|never|no)\b)/gi;

/** A negation earlier in the same clause turns the match into a denial ("isn't a language you've used"). */
const NEGATION = /n't\b|\b(?:not|never|no|without|lack|lacks|lacking)\b/i;
const CLAUSE_BOUNDARY = /[,;:–—]/g;

/**
 * D102: does the framing of a gap question read as a claim that the candidate has the missing `term`?
 * Returns the first offending sentence, or null. A sentence is flagged when a claim pattern (not negated
 * right after it, and with no negation earlier in its clause) is followed later in the same sentence by
 * the term -- `containsTerm`, the boundary-aware matcher computeGapTerms uses, so "Go" never matches
 * inside "Google". Used by BOTH applyInterviewPrepGuard (enforced) and the interview-prep eval (reported).
 * A heuristic: it cannot see every paraphrase of a claim, and it errs toward flagging.
 */
export function findSkillClaim(framing: string, term: string): string | null {
  const termLower = term.trim().toLowerCase();
  if (termLower.length === 0) return null;
  for (const sentence of framing.split(/(?<=[.!?])\s+/)) {
    const text = sentence.replace(/[‘’]/g, "'");
    for (const match of text.matchAll(CLAIM_PATTERN)) {
      const start = match.index ?? 0;
      const before = text.slice(0, start);
      const clauseStart = Math.max(0, ...[...before.matchAll(CLAUSE_BOUNDARY)].map((m) => (m.index ?? 0) + 1));
      if (NEGATION.test(before.slice(clauseStart))) continue;
      if (containsTerm(text.slice(start + match[0].length).toLowerCase(), termLower)) return sentence;
    }
  }
  return null;
}
