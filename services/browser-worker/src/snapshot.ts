import type { Page } from "playwright-core";
import { EXTRACT_SNAPSHOT_SOURCE, type FormSnapshot, type PortalAdapter } from "@ai-career/browser";

/** Evaluated as a string expression: functions compiled by tsx would carry `__name` helpers the page lacks (D131). */
export async function takeSnapshot(page: Page, adapter: PortalAdapter): Promise<FormSnapshot> {
  return (await page.evaluate(`(${EXTRACT_SNAPSHOT_SOURCE})(${JSON.stringify(adapter.snapshotConfig)})`)) as FormSnapshot;
}

/** First 5,000 chars of visible text, for confirmation detection only. Never logged or stored. */
export async function readPageText(page: Page): Promise<string> {
  return (await page.evaluate(`document.body ? document.body.innerText.slice(0, 5000) : ""`)) as string;
}
