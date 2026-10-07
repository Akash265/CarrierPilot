import { createLogger, type Logger } from "@ai-career/logging";
import { DEFAULT_KEY_PREFIX, type Heartbeat, type WorkerName } from "./workerState";

export interface HeartbeatOptions {
  intervalMs?: number;
  now?: () => Date;
  keyPrefix?: string;
  logger?: Logger;
  /** stop() waits at most this long for its write (default 2 s): a worker's Redis waits forever when unreachable. */
  stopTimeoutMs?: number;
}

class HeartbeatTimeout extends Error {
  constructor() {
    super("heartbeat write timed out");
    this.name = "HeartbeatTimeout";
  }
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

  const write = async (stoppedAt: string | null, timeoutMs?: number) => {
    const beatAt = now().toISOString();
    const value: Heartbeat = { startedAt, beatAt, pid: process.pid, stoppedAt: stoppedAt === null ? null : beatAt };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = redis.set(key, JSON.stringify(value));
      if (timeoutMs === undefined) {
        await pending;
      } else {
        pending.catch(() => undefined);
        await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new HeartbeatTimeout()), timeoutMs);
          }),
        ]);
      }
    } catch (error) {
      log.error("heartbeat_failed", { worker, error });
    } finally {
      if (timer) clearTimeout(timer);
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
      await write("stop", opts.stopTimeoutMs ?? 2000);
    },
  };
}
