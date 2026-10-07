import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging } from "@ai-career/logging";
import { startHeartbeat } from "@ai-career/monitoring";
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
  // Phase 11b: /status shows this worker running while it beats, and stopped after a clean shutdown.
  const heartbeat = await startHeartbeat(connection, "maintenance");
  log.info("worker_started", { retentionDays: env.RETENTION_DAYS });

  // Both signal handlers can fire for one shutdown (a double Ctrl-C, or a wrapper forwarding the signal); only the
  // first run may close the worker, heartbeat, Redis and database -- a second connection.quit() crashes the process.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopRedactionRefresh();
    await worker.close();
    await queue.close();
    await heartbeat.stop();
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
