import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { createRetentionStorage } from "./storageAdapter";
import { createMaintenanceWorker, scheduleRetention } from "./worker";
import { MAINTENANCE_QUEUE_NAME } from "./queue";

// Structured logs only: ids, counts and error classes -- never document or note content (CLAUDE.md §9).
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
const safeErrorLabel = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, { connection });
  const storage = createRetentionStorage(createStorageClient(env));

  const worker = createMaintenanceWorker({ connection, db, storage, userId: env.DEFAULT_USER_ID, retentionDays: env.RETENTION_DAYS });
  worker.on("completed", (job, result) => log("maintenance_completed", { jobId: job.id, name: job.name, ...result }));
  worker.on("failed", (job, error) => log("maintenance_failed", { jobId: job?.id, name: job?.name, error: safeErrorLabel(error) }));
  await scheduleRetention(queue);
  log("worker_started", { retentionDays: env.RETENTION_DAYS });

  const shutdown = async () => {
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
  log("worker_crashed", { error: safeErrorLabel(error) });
  process.exit(1);
});
