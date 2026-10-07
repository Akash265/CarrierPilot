import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging } from "@ai-career/logging";
import { createStorageClient } from "@ai-career/storage";
import { createRetentionStorage } from "./storageAdapter";
import { createMaintenanceWorker, scheduleRetention } from "./worker";
import { MAINTENANCE_QUEUE_NAME } from "./queue";

// Structured logs only: ids, counts and error classes -- never document or note content (CLAUDE.md §9, Phase 11b).
const log = createLogger({ service: "maintenance-worker" });

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const stopRedactionRefresh = await initProcessLogging({
    level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log,
  });
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, { connection });
  const storage = createRetentionStorage(createStorageClient(env));

  const worker = createMaintenanceWorker({ connection, db, storage, userId: env.DEFAULT_USER_ID, retentionDays: env.RETENTION_DAYS });
  worker.on("completed", (job, result) => log.info("maintenance_completed", { jobId: job.id, name: job.name, ...result }));
  worker.on("failed", (job, error) => log.error("maintenance_failed", { jobId: job?.id, name: job?.name, error }));
  await scheduleRetention(queue);
  log.info("worker_started", { retentionDays: env.RETENTION_DAYS });

  const shutdown = async () => {
    stopRedactionRefresh();
    await worker.close();
    await queue.close();
    await connection.quit();
    await closeDbClient(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log.error("worker_crashed", { error });
  process.exit(1);
});
