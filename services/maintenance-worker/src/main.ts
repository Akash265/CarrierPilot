import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging, throttleErrorLog } from "@ai-career/logging";
import { createShutdown, originalJobError, startHeartbeat } from "@ai-career/monitoring";
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
  // Phase 11b: beat from right after Redis opens, so /status shows this worker running -- and a crash later in
  // startup reads as "stale" -- at the configured interval; a clean shutdown records "stopped".
  const heartbeat = await startHeartbeat(connection, "maintenance", { intervalMs: env.HEARTBEAT_INTERVAL_MS });
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, { connection });
  const storage = createRetentionStorage(createStorageClient(env));

  const worker = createMaintenanceWorker({ connection, db, storage, userId: env.DEFAULT_USER_ID, retentionDays: env.RETENTION_DAYS });
  worker.on("completed", (job, result) => log.info("maintenance_completed", { jobId: job.id, name: job.name, ...result }));
  worker.on("failed", (job, rawError) => {
    const error = originalJobError(rawError);
    log.error("maintenance_failed", { jobId: job?.id, name: job?.name, error });
  });
  // Redis connection errors are re-emitted here; with no listener the worker would crash with Node's raw print.
  worker.on("error", throttleErrorLog(log, "worker_error"));
  await scheduleRetention(queue);
  log.info("worker_started", { retentionDays: env.RETENTION_DAYS });

  // Runs once however many signals arrive, exits 0, and is cut off with exit 1 if a step hangs (Redis unreachable).
  const shutdown = createShutdown({
    logger: log,
    steps: async () => {
      stopRedactionRefresh();
      await worker.close();
      await queue.close();
      await heartbeat.stop();
      await connection.quit();
      await closeDbClient(db);
    },
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log.error("worker_crashed", { error });
  process.exit(1);
});
