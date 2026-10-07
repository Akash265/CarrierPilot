import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 11a structural guard: every production AI call must go through the tracked path, or the monthly
 * budget has a hole. Tests, evals and E2E helpers may build raw clients; production code may not.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "eval", "e2e", "test", "testing", "fixtures"]);
const isTestFile = (f: string) => /\.test\.tsx?$/.test(f);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mts)$/.test(name) && !isTestFile(name)) {
      out.push(full);
    }
  }
  return out;
}

const productionFiles = ["apps", "services", "packages"].flatMap((top) => sourceFiles(path.join(REPO, top)));
const rel = (f: string) => path.relative(REPO, f);
const filesMatching = (re: RegExp) => productionFiles.filter((f) => re.test(readFileSync(f, "utf8"))).map(rel).sort();

describe("no untracked AI calls in production code", () => {
  it("scans a realistic number of files (the walk itself works)", () => {
    expect(productionFiles.length).toBeGreaterThan(100);
  });

  it("calls createAnthropicClient nowhere but its own definition (evals may still use it)", () => {
    expect(filesMatching(/createAnthropicClient\(/)).toEqual(["packages/ai/src/extractProfile.ts"]);
  });

  it("constructs the Anthropic SDK client only inside packages/ai", () => {
    expect(filesMatching(/new Anthropic\(/)).toEqual(["packages/ai/src/extractProfile.ts", "packages/ai/src/usage/anthropicFor.ts"]);
  });

  it("talks to Voyage only through embedTexts", () => {
    expect(filesMatching(/api\.voyageai\.com/)).toEqual(["packages/ai/src/embeddings.ts"]);
  });
});
