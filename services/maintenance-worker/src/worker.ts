import { contentFreeJobError } from "@ai-career/monitoring";
import { Worker, UnrecoverableError, type ConnectionOptions, type Queue } from "bullmq";
import type { DbClient } from "@ai-career/db";
import { runRetentionSweep, type RetentionStorage, type RetentionSweepResult } from "@ai-career/applications";
import { MAINTENANCE_QUEUE_NAME, RETENTION_EVERY_MS, RETENTION_JOB_NAME, RETENTION_SCHEDULER_ID } from "./queue";

export interface MaintenanceWorkerDeps {
  connection: ConnectionOptions;
  db: DbClient;
  storage: RetentionStorage;
  userId: string;
  retentionDays: number;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/** Holds no domain logic: dispatches by job name to packages/applications. Concurrency 1 (personal tool). */
export function createMaintenanceWorker(deps: MaintenanceWorkerDeps): Worker<unknown, RetentionSweepResult> {
  return new Worker<unknown, RetentionSweepResult>(
    deps.queueName ?? MAINTENANCE_QUEUE_NAME,
    async (job) => {
      try {
        if (job.name !== RETENTION_JOB_NAME) throw new UnrecoverableError("unknown_maintenance_job");
        return await runRetentionSweep({ db: deps.db, storage: deps.storage, userId: deps.userId, retentionDays: deps.retentionDays });
      } catch (error) {
        throw contentFreeJobError(error);
      }
    },
    { connection: deps.connection, concurrency: 1 }
  );
}

/** Upsert is idempotent: re-running on every boot keeps exactly one daily scheduler. */
export async function scheduleRetention(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(RETENTION_SCHEDULER_ID, { every: RETENTION_EVERY_MS }, { name: RETENTION_JOB_NAME, data: {} });
}
