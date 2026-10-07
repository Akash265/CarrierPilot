import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Final-review fix (D173): a BullMQ Worker re-emits Redis connection errors as 'error', and an EventEmitter with no
 * 'error' listener throws -- crashing the worker with Node's raw print (message included). Every worker listens and
 * logs the error message-free; BullMQ then reconnects on its own.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKERS = ["job-ingestion", "matching-worker", "maintenance-worker", "browser-worker"];

describe("every worker listens for BullMQ 'error' events", () => {
  it.each(WORKERS)("services/%s/src/main.ts logs worker errors through the logger", (svc) => {
    const source = readFileSync(path.join(REPO, `services/${svc}/src/main.ts`), "utf8");
    expect(source).toContain('worker.on("error", (error) => log.error("worker_error", { error }));');
  });
});
