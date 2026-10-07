import { Queue, type ConnectionOptions } from "bullmq";
import { DEFAULT_KEY_PREFIX, WORKERS, failureCode, workerState, type Heartbeat, type WorkerName, type WorkerState } from "./workerState";

export interface WorkerStatus {
  worker: WorkerName;
  optional: boolean;
  state: WorkerState;
  startedAt: string | null;
  lastSeenAt: string | null;
  stoppedAt: string | null;
}

export interface QueueStatus {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  lastFailedAt: string | null;
  lastFailedCode: string | null;
}

function parseHeartbeat(raw: string | null): Heartbeat | null | "malformed" {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Heartbeat>;
    if (typeof v.startedAt === "string" && typeof v.beatAt === "string" && (v.stoppedAt === null || typeof v.stoppedAt === "string")) {
      return { startedAt: v.startedAt, beatAt: v.beatAt, pid: typeof v.pid === "number" ? v.pid : 0, stoppedAt: v.stoppedAt };
    }
  } catch {
    // fall through
  }
  return "malformed";
}

/** Design §5.2: every known worker's state, in display order. */
export async function readWorkerStatus(
  redis: { mget(...keys: string[]): Promise<(string | null)[]> },
  now: Date,
  opts: { staleAfterMs: number; keyPrefix?: string }
): Promise<WorkerStatus[]> {
  const prefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const raws = await redis.mget(...WORKERS.map((w) => `${prefix}${w.worker}`));
  return WORKERS.map(({ worker, optional }, i) => {
    const beat = parseHeartbeat(raws[i] ?? null);
    if (beat === "malformed") return { worker, optional, state: "stale" as const, startedAt: null, lastSeenAt: null, stoppedAt: null };
    return {
      worker,
      optional,
      state: workerState(beat, now, opts.staleAfterMs),
      startedAt: beat?.startedAt ?? null,
      lastSeenAt: beat?.beatAt ?? null,
      stoppedAt: beat?.stoppedAt ?? null,
    };
  });
}

/** Design §5.2: per-queue counts and the most recent failure (its time, and its reason only if code-shaped). */
export async function readQueueStatus(connection: ConnectionOptions, queueNames: readonly string[]): Promise<QueueStatus[]> {
  const out: QueueStatus[] = [];
  for (const name of queueNames) {
    const queue = new Queue(name, { connection });
    try {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
      const [last] = await queue.getFailed(0, 0);
      out.push({
        queue: name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        lastFailedAt: last?.finishedOn ? new Date(last.finishedOn).toISOString() : null,
        lastFailedCode: last ? failureCode(last.failedReason) : null,
      });
    } finally {
      await queue.close();
    }
  }
  return out;
}
