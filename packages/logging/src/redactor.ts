/**
 * D9 (Phase 11b design §3.3): exact, case-insensitive replacement of the user's known profile values, plus one
 * generic email-address pattern (D9 ruled out regexes for names, which have no reliable shape; emails do).
 */
const MIN_VALUE_LENGTH = 3;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  private pattern: RegExp | null = null;

  /** Replaces the whole set. Values are trimmed; values under 3 characters are ignored; longest first. */
  setValues(values: string[]): void {
    const usable = [...new Set(values.map((v) => v.trim()).filter((v) => v.length >= MIN_VALUE_LENGTH))].sort(
      (a, b) => b.length - a.length
    );
    this.pattern = usable.length === 0 ? null : new RegExp(usable.map(escapeRegExp).join("|"), "gi");
  }

  redact(text: string): string {
    const known = this.pattern ? text.replace(this.pattern, "[REDACTED]") : text;
    return known.replace(EMAIL, "[REDACTED_EMAIL]");
  }
}
