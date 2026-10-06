/**
 * Phase 10a spec §6. The required job terms the sent resume text does not contain -- the same rule as
 * packages/resume-optimization's scoreKeywordCoverage (case-insensitive plain substring, blank terms skipped),
 * so the snapshot's missed terms agree with its keywordCoverage number. Kept here rather than imported so this
 * package stays free of resume-optimization's Anthropic dependency; missedTerms.test.ts pins the parity.
 */
export function findMissedTerms(terms: readonly string[], text: string): string[] {
  const haystack = text.toLowerCase();
  const seen = new Set<string>();
  const missed: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length === 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!haystack.includes(raw.toLowerCase())) missed.push(term);
  }
  return missed;
}

/** resume_optimizations.selected_bullets -> the text runResumeOptimization scored (each optimizedText, joined by "\n"). */
export function joinOptimizedText(selectedBullets: unknown): string {
  if (!Array.isArray(selectedBullets)) return "";
  return selectedBullets
    .map((b) => (typeof b === "object" && b !== null && typeof (b as { optimizedText?: unknown }).optimizedText === "string"
      ? (b as { optimizedText: string }).optimizedText
      : null))
    .filter((t): t is string => t !== null)
    .join("\n");
}
