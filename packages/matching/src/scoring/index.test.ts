import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as scoring from "./index";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every import/export-from specifier in a TypeScript source file. */
function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

/** All files reachable from `entry` through relative imports, plus every non-relative specifier met on the way. */
function walk(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(file)) {
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      queue.push(path.resolve(path.dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`));
    }
  }
  return { files: [...seen], external: [...external] };
}

describe("@ai-career/matching/scoring", () => {
  it("reaches no package outside its own folder and types.ts (no Anthropic SDK, @ai-career/ai, database or queue)", () => {
    const { files, external } = walk(path.join(HERE, "index.ts"));
    expect(external).toEqual([]);
    for (const file of files) {
      expect(file.startsWith(HERE) || file === path.resolve(HERE, "../types.ts")).toBe(true);
    }
  });

  it("exports the scoring rules and the factor keys in FACTOR_WEIGHTS order", () => {
    expect(typeof scoring.scoreRole).toBe("function");
    expect(typeof scoring.computeOverallScore).toBe("function");
    expect(scoring.FACTOR_KEYS).toEqual([
      "skillsScore", "experienceScore", "locationScore", "sponsorshipScore", "roleScore", "salaryScore", "industryScore",
      "freshnessScore", "semanticScore",
    ]);
  });
});
