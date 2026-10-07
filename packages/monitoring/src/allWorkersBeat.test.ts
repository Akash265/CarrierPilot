import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 11b design §5.1 and the review fixes (D174): every worker process beats under its /status name, at the
 * configured interval, from right after its Redis connection opens (so a crash later in startup reads as "stale",
 * not as an old "Stopped"); and it shuts down through createShutdown -- once, with a deadline -- recording a clean
 * stop before closing Redis. The entry points are not unit-testable (they start real workers), so this pins the
 * wiring structurally; the E2E exercises it for real.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WIRING: Array<[string, string]> = [
  ["services/job-ingestion/src/main.ts", "job-ingestion"],
  ["services/matching-worker/src/main.ts", "matching"],
  ["services/maintenance-worker/src/main.ts", "maintenance"],
  ["services/browser-worker/src/main.ts", "browser"],
];

const read = (file: string) => readFileSync(path.join(REPO, file), "utf8");

describe("every worker beats", () => {
  it.each(WIRING)("%s beats as %s at the configured interval, right after opening Redis", (file, name) => {
    const source = read(file);
    expect(source).toMatch(
      new RegExp(
        `const connection = new IORedis\\([^\\n]*\\);\\n(\\s*//[^\\n]*\\n)*\\s*const heartbeat = await startHeartbeat\\(connection, "${name}", \\{ intervalMs: env\\.HEARTBEAT_INTERVAL_MS \\}\\);`
      )
    );
  });

  it.each(WIRING)("%s shuts down through createShutdown, stopping the heartbeat before closing Redis", (file) => {
    const source = read(file);
    const shutdown = source.slice(source.indexOf("const shutdown = createShutdown({"));
    expect(shutdown.length).toBeLessThan(source.length);
    const stopAt = shutdown.indexOf("await heartbeat.stop();");
    expect(stopAt).toBeGreaterThan(0);
    expect(stopAt).toBeLessThan(shutdown.indexOf("await connection.quit();"));
    expect(source).not.toContain("process.exit(0)");
    expect(source).not.toContain("let stopping");
    expect(source).toContain('process.on("SIGINT", () => void shutdown());');
    expect(source).toContain('process.on("SIGTERM", () => void shutdown());');
  });
});
