import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { runRetentionSweep } from "@ai-career/applications";
import { createRetentionStorage } from "./storageAdapter";

/** `pnpm retention:run`: one sweep now, same code path as the daily job. Prints counts only. */
async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await runRetentionSweep({
      db, storage: createRetentionStorage(createStorageClient(env)), userId: env.DEFAULT_USER_ID, retentionDays: env.RETENTION_DAYS,
    });
    console.log(JSON.stringify({ event: "retention_run", ...result }));
  } finally {
    await closeDbClient(db);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ event: "retention_run_failed", error: error instanceof Error ? error.name : "unknown" }));
  process.exit(1);
});
