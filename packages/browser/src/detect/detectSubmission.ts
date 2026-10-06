import type { PortalAdapter } from "../adapters/types";

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};
const withoutHash = (u: URL): string => `${u.origin}${u.pathname}${u.search}`;

/**
 * Design §4.6. Only a hint -- recording an application still needs the user's click. A page counts when it is on
 * the form's own host and either its path matches a confirmation pattern, or (away from the form URL itself) its
 * visible text does.
 */
export function detectSubmission(adapter: PortalAdapter, page: { url: string; text: string; formUrl: string }): boolean {
  const url = parse(page.url);
  const form = parse(page.formUrl);
  if (!url || !form || url.host !== form.host) return false;
  if (adapter.confirmation.urlPatterns.some((p) => p.test(url.pathname))) return true;
  if (withoutHash(url) === withoutHash(form)) return false;
  return adapter.confirmation.textPatterns.some((p) => p.test(page.text));
}
