import { createLogger, type Logger } from "@ai-career/logging";
import { DEFAULT_KEY_PREFIX, type Heartbeat, type WorkerName } from "./workerState";

export interface HeartbeatOptions {
  intervalMs?: number;
  now?: () => Date;
  keyPrefix?: string;
  logger?: Logger;
}

export interface HeartbeatHandle {
  /** Clears the timer and records a clean stop. Never throws. */
  stop(): Promise<void>;
}

/**
 * Phase 11b design §5.1. Writes `<prefix><worker>` = `{ startedAt, beatAt, pid, stoppedAt }` now and every
 * `intervalMs` (default 30 s) on an unref()'d timer. The key never expires, so /status can say when a worker was
 * last seen. Write failures are logged by error name and never thrown: monitoring must not stop a worker.
 */
export async function startHeartbeat(
  redis: { set(key: string, value: string): Promise<unknown> },
  worker: WorkerName,
  opts: HeartbeatOptions = {}
): Promise<HeartbeatHandle> {
  const now = opts.now ?? (() => new Date());
  const key = `${opts.keyPrefix ?? DEFAULT_KEY_PREFIX}${worker}`;
  const log = opts.logger ?? createLogger({ service: "monitoring" });
  const startedAt = now().toISOString();
  let stopped = false;

  const write = async (stoppedAt: string | null) => {
    const beatAt = now().toISOString();
    const value: Heartbeat = { startedAt, beatAt, pid: process.pid, stoppedAt: stoppedAt === null ? null : beatAt };
    try {
      await redis.set(key, JSON.stringify(value));
    } catch (error) {
      log.error("heartbeat_failed", { worker, error });
    }
  };

  await write(null);
  const timer = setInterval(() => {
    if (!stopped) void write(null);
  }, opts.intervalMs ?? 30_000);
  timer.unref?.();

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await write("stop");
    },
  };
}
