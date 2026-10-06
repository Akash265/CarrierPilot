import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { EXTRACT_SNAPSHOT_SOURCE } from "../snapshot/extractSnapshotSource";
import type { SnapshotConfig } from "../adapters/types";
import type { FormSnapshot } from "../types";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

/** Sanitized copies of the live forms (captured 2026-10-01). */
export const readFixture = (name: "greenhouse-v1-form.html" | "lever-v1-form.html"): string =>
  readFileSync(path.join(FIXTURES, name), "utf8");

/** Runs the real in-page extractor in jsdom. JSON round-trip: values from the jsdom realm compare cleanly. */
export function snapshotFromHtml(html: string, config: SnapshotConfig, url = "https://example.test/form"): FormSnapshot {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  try {
    const result = dom.window.eval(`(${EXTRACT_SNAPSHOT_SOURCE})(${JSON.stringify(config)})`);
    return JSON.parse(JSON.stringify(result)) as FormSnapshot;
  } finally {
    dom.window.close();
  }
}
