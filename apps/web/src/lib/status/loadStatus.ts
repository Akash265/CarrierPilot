import IORedis from "ioredis";
import { sql } from "drizzle-orm";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { QUEUES, readQueueStatus, readWorkerStatus, type QueueStatus, type WorkerStatus } from "@ai-career/monitoring";

export interface StatusReport {
  checkedAt: string;
  database: "ok" | "unavailable";
  redis: "ok" | "unavailable";
  workers: WorkerStatus[];
  queues: QueueStatus[];
}

export interface StatusEnv {
  DATABASE_URL: string;
  REDIS_URL: string;
  STATUS_STALE_AFTER_MS: number;
}

const TIMEOUT_MS = 5000;

/** Resolves or rejects with `promise`, or rejects after `ms`; the timer never outlives the race. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkDatabase(env: StatusEnv): Promise<"ok" | "unavailable"> {
  let db: ReturnType<typeof createDbClient> | null = null;
  try {
    db = createDbClient(env);
    await withTimeout(db.execute(sql`SELECT 1`), TIMEOUT_MS);
    return "ok";
  } catch {
    return "unavailable";
  } finally {
    if (db) await withTimeout(closeDbClient(db), 1000).catch(() => undefined);
  }
}

type RedisPart = Pick<StatusReport, "redis" | "workers" | "queues">;

async function checkRedis(env: StatusEnv, now: Date): Promise<RedisPart> {
  let connection: IORedis | null = null;
  try {
    connection = new IORedis(env.REDIS_URL, {
      lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000, retryStrategy: () => null,
    });
    // Emits 'error' while Redis is unreachable; without a listener that would crash the process.
    connection.on("error", () => undefined);
    // Connect explicitly first: with the offline queue disabled, a command sent before the socket is ready is
    // rejected rather than queued.
    await withTimeout(connection.connect(), TIMEOUT_MS);
    await withTimeout(connection.ping(), TIMEOUT_MS);
    const workers = await withTimeout(readWorkerStatus(connection, now, { staleAfterMs: env.STATUS_STALE_AFTER_MS }), TIMEOUT_MS);
    const queues = await withTimeout(readQueueStatus(connection, QUEUES), TIMEOUT_MS);
    return { redis: "ok", workers, queues };
  } catch {
    return { redis: "unavailable", workers: [], queues: [] };
  } finally {
    connection?.disconnect();
  }
}

/** What /status shows when nothing can be checked at all (e.g. the configuration itself is invalid). */
export function unavailableReport(now: Date = new Date()): StatusReport {
  return { checkedAt: now.toISOString(), database: "unavailable", redis: "unavailable", workers: [], queues: [] };
}

/**
 * Phase 11b design §5.3. Never throws: an unreachable database or Redis -- or a client that cannot even be created
 * from the configured URL -- is reported as "unavailable" (Redis down means no worker or queue status can be read).
 * The two checks run in parallel, so two hanging services cost one timeout. Redis is opened fail-fast, like the
 * enqueue helpers, so an outage answers within the timeout instead of hanging.
 */
export async function loadStatus(env: StatusEnv, now: Date = new Date()): Promise<StatusReport> {
  const [database, redisPart] = await Promise.all([checkDatabase(env), checkRedis(env, now)]);
  return { checkedAt: now.toISOString(), database, ...redisPart };
}
