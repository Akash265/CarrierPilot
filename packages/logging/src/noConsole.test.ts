import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 11b structural guard: production code logs only through @ai-career/logging, whose lines are sanitized and
 * scrubbed. A bare console call -- or a direct write to process.stdout/stderr -- can print an error message or content
 * verbatim. Tests, evals, E2E helpers and build scripts (`scripts/`) may print freely; the logger itself is the one
 * production file that writes to the streams.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "eval", "e2e", "test", "testing", "fixtures", "scripts"]);
const STREAM_WRITER = "packages/logging/src/logger.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = ["apps", "services", "packages"].flatMap((top) => sourceFiles(path.join(REPO, top)));

describe("no console calls in production code", () => {
  it("scans a realistic number of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds no console.* outside tests, evals and E2E helpers", () => {
    const offenders = files
      .filter((f) => /\bconsole\.[a-z]+\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("writes to process.stdout/stderr only from the logger", () => {
    const offenders = files
      .filter((f) => /process\.(stdout|stderr)\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f))
      .filter((f) => f !== STREAM_WRITER)
      .sort();
    expect(offenders).toEqual([]);
  });
});
