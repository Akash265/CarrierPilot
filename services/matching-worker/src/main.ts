import IORedis from "ioredis";
import { loadEnv } from "@ai-career/config";
import { DbUsageSink, closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging } from "@ai-career/logging";
import { startHeartbeat } from "@ai-career/monitoring";
import { createAnthropicFor, withLangfuseExport, type AiUsageSink } from "@ai-career/ai";
import { createMatchingWorker } from "./worker";

// Structured logs only: ids and error classes, never job or profile content (CLAUDE.md §9, Phase 11b).
const log = createLogger({ service: "matching-worker" });

/** Our own error classes carry a fixed error class as their message, so that one message is safe to log. */
const failureFields = (error: unknown) => ({
  error,
  ...(error instanceof Error && (error.name === "UnrecoverableError" || error.name === "MatchingError") ? { errorClass: error.message } : {}),
});

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const stopRedactionRefresh = await initProcessLogging({
    level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log,
  });
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const aiFor = (userId: string) => {
    // Typed as AiUsageSink so the compiler checks DbUsageSink still matches the AI package's interface.
    const usageSink: AiUsageSink = withLangfuseExport(new DbUsageSink(db, userId), env);
    return { usageSink, anthropicFor: createAnthropicFor(env, usageSink) };
  };

  const worker = createMatchingWorker({ connection, db, aiFor, env });
  worker.on("completed", (job) => log.info("matching_completed", { jobId: job.id }));
  worker.on("failed", (job, error) => log.error("matching_failed", { jobId: job?.id, ...failureFields(error) }));
  // Phase 11b: /status shows this worker running while it beats, and stopped after a clean shutdown.
  const heartbeat = await startHeartbeat(connection, "matching");
  log.info("worker_started");

  // Both signal handlers can fire for one shutdown (a double Ctrl-C, or a wrapper forwarding the signal); only the
  // first run may close the worker, heartbeat, Redis and database -- a second connection.quit() crashes the process.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopRedactionRefresh();
    await worker.close();
    await heartbeat.stop();
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
