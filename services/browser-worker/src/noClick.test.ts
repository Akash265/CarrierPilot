import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [/\.click\(/, /\.dblclick\(/, /\.tap\(/, /\.press\(/, /\.submit\(/, /keyboard/, /requestSubmit/, /dispatchEvent/];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "testing" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

/** Design §5: stop-before-submit is structural. The worker has no way to click, press keys or submit. */
describe("browser-worker source", () => {
  it("contains no click, key-press or submit call", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, i) =>
        FORBIDDEN.filter((p) => p.test(line)).map((p) => `${path.relative(SRC, file)}:${i + 1} ${p}`)
      )
    );
    expect(hits).toEqual([]);
  });
});
