import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging } from "@ai-career/logging";
import { INGEST_QUEUE_NAME, createAdapterFor, type IngestJobData } from "@ai-career/ingestion";
import { reconcileSchedules } from "./reconcile";
import { createIngestWorker } from "./worker";

// Structured logs only, and never posting content: ids, counts and error classes (CLAUDE.md §9, D29, Phase 11b).
const log = createLogger({ service: "job-ingestion" });

/** Our own error classes carry a fixed error class as their message, so that one message is safe to log. */
const failureFields = (error: unknown) => ({
  error,
  ...(error instanceof Error && (error.name === "UnrecoverableError" || error.name === "IngestError") ? { errorClass: error.message } : {}),
});

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const stopRedactionRefresh = await initProcessLogging({
    level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log,
  });
  // BullMQ workers require maxRetriesPerRequest: null on their connection.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, { connection });
  const adapterFor = createAdapterFor({
    db,
    userId: env.DEFAULT_USER_ID,
    greenhouseBaseUrl: env.GREENHOUSE_API_BASE,
    leverBaseUrl: env.LEVER_API_BASE,
  });
  const worker = createIngestWorker({ connection, db, userId: env.DEFAULT_USER_ID, adapterFor });
  worker.on("completed", (job) => log.info("ingest_completed", { jobId: job.id }));
  worker.on("failed", (job, error) => log.error("ingest_failed", { jobId: job?.id, ...failureFields(error) }));

  const everyMs = env.INGEST_INTERVAL_MINUTES * 60_000;
  const reconcile = async (refresh: boolean) => {
    try {
      const plan = await reconcileSchedules({ db, userId: env.DEFAULT_USER_ID, queue, everyMs, refresh });
      if (refresh || plan.upsert.length > 0 || plan.remove.length > 0) {
        log.info("schedules_reconciled", { upserted: plan.upsert.length, removed: plan.remove.length });
      }
    } catch (error) {
      log.error("schedule_reconcile_failed", failureFields(error));
    }
  };

  await reconcile(true);
  // The database is the source of truth: pick up sources enabled/disabled from the web app.
  const timer = setInterval(() => void reconcile(false), 60_000);
  log.info("worker_started", { everyMinutes: env.INGEST_INTERVAL_MINUTES });

  const shutdown = async () => {
    clearInterval(timer);
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
  log.error("worker_crashed", failureFields(error));
  process.exit(1);
});
