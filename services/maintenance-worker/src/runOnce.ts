import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging } from "@ai-career/logging";
import { createStorageClient } from "@ai-career/storage";
import { runRetentionSweep } from "@ai-career/applications";
import { createRetentionStorage } from "./storageAdapter";

const log = createLogger({ service: "maintenance-worker" });

/** `pnpm retention:run`: one sweep now, same code path as the daily job. Prints counts only. */
async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const stopRedactionRefresh = await initProcessLogging({
    level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log,
  });
  try {
    const result = await runRetentionSweep({
      db, storage: createRetentionStorage(createStorageClient(env)), userId: env.DEFAULT_USER_ID, retentionDays: env.RETENTION_DAYS,
    });
    log.info("retention_run", { ...result });
  } finally {
    stopRedactionRefresh();
    await closeDbClient(db);
  }
}

main().catch((error) => {
  log.error("retention_run_failed", { error });
  process.exit(1);
});
