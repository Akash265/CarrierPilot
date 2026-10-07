import IORedis from "ioredis";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging, throttleErrorLog } from "@ai-career/logging";
import { createShutdown, startHeartbeat } from "@ai-career/monitoring";
import { createStorageClient } from "@ai-career/storage";
import { sweepInterruptedSessions } from "@ai-career/browser";
import { minioFetcher } from "./attachments";
import { ReleasedWindows, removeStaleSessionDirs } from "./browser";
import { createBrowserWorker } from "./worker";

// Structured logs only: ids, statuses and error classes -- never field values, labels or URLs (CLAUDE.md §9, Phase 11b).
const log = createLogger({ service: "browser-worker" });

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const stopRedactionRefresh = await initProcessLogging({
    level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log,
  });
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // Phase 11b: beat from right after Redis opens, so /status shows this worker running -- and a crash later in
  // startup reads as "stale" -- at the configured interval; a clean shutdown records "stopped".
  const heartbeat = await startHeartbeat(connection, "browser", { intervalMs: env.HEARTBEAT_INTERVAL_MS });
  const released = new ReleasedWindows();

  // Spec §5. Single-worker assumption: only one browser-worker process is ever expected to run, so any
  // careerpilot-autofill-* directory left in the OS temp dir belongs to a previous process that crashed or was
  // killed before it could clean up its own window (see runSession's finally / ReleasedWindows.setActive).
  const removedTempDirs = await removeStaleSessionDirs();
  // Spec §11.5: sessions a previous worker process owned can never finish now.
  const swept = await sweepInterruptedSessions(db, env.DEFAULT_USER_ID);

  const worker = createBrowserWorker({
    connection,
    db,
    fetchDocument: minioFetcher(createStorageClient(env)),
    browser: { headless: env.BROWSER_HEADLESS, executablePath: env.BROWSER_EXECUTABLE_PATH },
    timeoutMs: env.BROWSER_SESSION_TIMEOUT_MIN * 60_000,
    released,
  });
  worker.on("completed", (job, result) => log.info("autofill_completed", { sessionId: job.data.sessionId, result }));
  worker.on("failed", (job, error) => log.error("autofill_failed", { sessionId: job?.data.sessionId, error }));
  // Redis connection errors are re-emitted here; with no listener the worker would crash with Node's raw print.
  worker.on("error", throttleErrorLog(log, "worker_error"));
  log.info("worker_started", { sweptSessions: swept, removedTempDirs, headless: env.BROWSER_HEADLESS });

  // Runs once however many signals arrive (both handlers can fire for one shutdown, e.g. a double Ctrl-C), exits 0,
  // and is cut off with exit 1 if a step hangs (Redis unreachable).
  const shutdown = createShutdown({
    logger: log,
    steps: async () => {
      stopRedactionRefresh();
      // force: an active session may be waiting minutes for the user; the next start sweeps it to failed.
      await worker.close(true);
      // closeAll also closes the one active (in-progress) window, if any -- see ReleasedWindows.setActive.
      await released.closeAll();
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
