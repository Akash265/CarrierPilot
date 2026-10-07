import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Phase 11c (D180): what a processor throws is stored by BullMQ in Redis, so every worker passes it through contentFreeJobError. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("every worker stores only content-free job errors", () => {
  it.each(["job-ingestion", "matching-worker", "maintenance-worker", "browser-worker"])("services/%s/src/worker.ts", (svc) => {
    const source = readFileSync(path.join(REPO, `services/${svc}/src/worker.ts`), "utf8");
    expect(source).toContain('import { contentFreeJobError } from "@ai-career/monitoring";');
    expect(source).toContain("throw contentFreeJobError(error);");
    expect(source, "no other rethrow").not.toMatch(/^\s*throw error;/m);
    // The failed handler logs the error the job actually threw (real frames, SQLSTATE), not the stored wrapper.
    const main = readFileSync(path.join(REPO, `services/${svc}/src/main.ts`), "utf8");
    expect(main).toMatch(/worker\.on\("failed", \(job, rawError\) => \{\n\s+const error = originalJobError\(rawError\);/);
  });
});
