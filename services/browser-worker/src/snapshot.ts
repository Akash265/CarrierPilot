import type { Page } from "playwright-core";
import { EXTRACT_SNAPSHOT_SOURCE, sanitizeSnapshot, type FormSnapshot, type PortalAdapter } from "@ai-career/browser";

/**
 * Evaluated as a string expression: functions compiled by tsx would carry `__name` helpers the page lacks
 * (D131). The page's return value is untrusted content (CLAUDE.md §9); `sanitizeSnapshot` hand-checks its
 * shape before anything else touches it. `null` means the shape didn't check out, which the caller treats
 * the same as a failed health check.
 */
export async function takeSnapshot(page: Page, adapter: PortalAdapter): Promise<FormSnapshot | null> {
  const raw = await page.evaluate(`(${EXTRACT_SNAPSHOT_SOURCE})(${JSON.stringify(adapter.snapshotConfig)})`);
  return sanitizeSnapshot(raw);
}

/** First 5,000 chars of visible text, for confirmation detection only. Never logged or stored. */
export async function readPageText(page: Page): Promise<string> {
  return (await page.evaluate(`document.body ? document.body.innerText.slice(0, 5000) : ""`)) as string;
}
