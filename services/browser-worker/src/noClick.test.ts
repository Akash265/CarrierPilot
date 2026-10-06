import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));
/** Design §4.2/§11.9: the snapshot extractor also runs inside the application page, same stop-before-submit stakes. */
const EXTRACT_SNAPSHOT_SOURCE_PATH = path.join(SRC, "..", "..", "..", "packages", "browser", "src", "snapshot", "extractSnapshotSource.ts");
const FORBIDDEN = [/\.click\(/, /\.dblclick\(/, /\.tap\(/, /\.press\(/, /\.submit\(/, /keyboard/, /requestSubmit/, /dispatchEvent/];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "testing" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

function scan(file: string, relativeTo: string): string[] {
  return readFileSync(file, "utf8").split("\n").flatMap((line, i) =>
    FORBIDDEN.filter((p) => p.test(line)).map((p) => `${path.relative(relativeTo, file)}:${i + 1} ${p}`)
  );
}

/**
 * Design §5: stop-before-submit is structural. The worker has no way to click, press keys or submit, and
 * neither does the plain-JS snapshot extractor it hands to `page.evaluate` (`EXTRACT_SNAPSHOT_SOURCE`,
 * packages/browser/src/snapshot/extractSnapshotSource.ts) -- the only other code that runs inside the
 * application page.
 */
describe("browser-worker source", () => {
  it("contains no click, key-press or submit call", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) => scan(file, SRC));
    expect(hits).toEqual([]);
  });

  it("the in-page snapshot extractor contains no click, key-press or submit call either", () => {
    const hits = scan(EXTRACT_SNAPSHOT_SOURCE_PATH, SRC);
    expect(hits).toEqual([]);
  });
});
