import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 11b design §4.2: every exported HTTP-method handler goes through withRouteErrors with its own route pattern,
 * so no error can escape to Next.js's default handler (which prints the raw message).
 */
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/api");
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

const files = routeFiles(API_DIR);
const patternOf = (file: string) => `/api/${path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/")}`;

describe("every API route handler is wrapped in withRouteErrors", () => {
  it("finds all 40 route files", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
  });

  it.each(files.map((f) => [patternOf(f), f]))("%s", (pattern, file) => {
    const source = readFileSync(file, "utf8");
    expect(source, "no unwrapped `export (async) function <METHOD>`").not.toMatch(new RegExp(`^export (async )?function (${METHODS})\\b`, "m"));
    const exported = [...source.matchAll(new RegExp(`^export const (${METHODS}) = (.*)$`, "gm"))];
    expect(exported.length, "exports at least one handler").toBeGreaterThan(0);
    for (const [, , rhs] of exported) {
      expect(rhs).toMatch(new RegExp(`^withRouteErrors\\("${pattern.replace(/[[\]]/g, "\\$&")}", `));
    }
  });
});
