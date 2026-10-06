import { Worker, type ConnectionOptions } from "bullmq";
import { BROWSER_QUEUE_NAME, type BrowserJobData } from "@ai-career/browser";
import { runSession, type RunSessionDeps, type RunSessionResult } from "./runSession";

export interface BrowserWorkerDeps extends RunSessionDeps {
  connection: ConnectionOptions;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/**
 * Concurrency 1: one automated window at a time (the DB's one-active-session index says the same). A job can
 * run for the whole session timeout; BullMQ renews the lock while the event loop is free.
 */
export function createBrowserWorker(deps: BrowserWorkerDeps): Worker<BrowserJobData, RunSessionResult> {
  return new Worker<BrowserJobData, RunSessionResult>(
    deps.queueName ?? BROWSER_QUEUE_NAME,
    (job) => runSession(deps, job.data),
    { connection: deps.connection, concurrency: 1, lockDuration: 60_000 }
  );
}
