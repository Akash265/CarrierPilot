import IORedis from "ioredis";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { sweepInterruptedSessions } from "@ai-career/browser";
import { minioFetcher } from "./attachments";
import { ReleasedWindows, removeStaleSessionDirs } from "./browser";
import { createBrowserWorker } from "./worker";

// Structured logs only: ids, statuses and error classes -- never field values, labels or URLs (CLAUDE.md §9).
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
const safeErrorLabel = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
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
  worker.on("completed", (job, result) => log("autofill_completed", { sessionId: job.data.sessionId, result }));
  worker.on("failed", (job, error) => log("autofill_failed", { sessionId: job?.data.sessionId, error: safeErrorLabel(error) }));
  log("worker_started", { sweptSessions: swept, removedTempDirs, headless: env.BROWSER_HEADLESS });

  let stopping = false;
  const shutdown = async () => {
    // Both signal handlers can fire for the same shutdown (e.g. a double Ctrl-C); only the first run should
    // touch the worker/connection/db, the rest of which are not safe to close twice.
    if (stopping) return;
    stopping = true;
    // force: an active session may be waiting minutes for the user; the next start sweeps it to failed.
    await worker.close(true);
    // closeAll also closes the one active (in-progress) window, if any -- see ReleasedWindows.setActive.
    await released.closeAll();
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
