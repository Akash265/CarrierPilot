import IORedis from "ioredis";
import { Queue } from "bullmq";
import { BROWSER_JOB_NAME, BROWSER_JOB_OPTIONS, BROWSER_QUEUE_NAME, browserJobId, type BrowserJobData } from "@ai-career/browser";

const ENQUEUE_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 1000;

/** Fixed message on purpose: driver errors carry the Redis host and port, which callers must never echo. */
const unavailable = () => new Error("queue unavailable");

/** Resolves or rejects with `promise`, or rejects with `onTimeout()` after `ms`. The timer never outlives the race. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Put an autofill session on the browser-worker queue. Same fail-fast producer settings as enqueueMatching /
 * enqueueIngestion (see their docstrings). No "already queued" check: the session row's one-active-per-user index
 * already guarantees at most one pending job, and the job id is per session.
 */
export async function enqueueAutofill(env: { REDIS_URL: string }, data: BrowserJobData, queueName: string = BROWSER_QUEUE_NAME): Promise<void> {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000, retryStrategy: () => null });
  const queue = new Queue<BrowserJobData>(queueName, { connection });
  connection.on("error", () => undefined);
  queue.on("error", () => undefined);
  try {
    await withTimeout(
      queue.add(BROWSER_JOB_NAME, data, { ...BROWSER_JOB_OPTIONS, jobId: browserJobId(data.sessionId) }),
      ENQUEUE_TIMEOUT_MS,
      unavailable
    );
  } catch {
    throw unavailable();
  } finally {
    await withTimeout(queue.close(), CLOSE_TIMEOUT_MS, unavailable).catch(() => undefined);
    connection.disconnect();
  }
}
