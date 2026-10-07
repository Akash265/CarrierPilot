/** Phase 11b design §5. The workers that beat, in display order; `optional` ones are normal to see stopped. */
export const WORKERS = [
  { worker: "job-ingestion", optional: false },
  { worker: "matching", optional: false },
  { worker: "maintenance", optional: true },
  { worker: "browser", optional: true },
] as const;

export type WorkerName = (typeof WORKERS)[number]["worker"];
export type WorkerState = "running" | "stopped" | "stale" | "never_seen";

/** The queues /status reports (the existing *_QUEUE_NAME values, by value to keep packages free of services). */
export const QUEUES = ["job-ingestion", "matching", "maintenance", "browser-automation"] as const;

export const DEFAULT_KEY_PREFIX = "careerpilot:worker:";

export interface Heartbeat {
  startedAt: string;
  beatAt: string;
  pid: number;
  stoppedAt: string | null;
}

/**
 * Design §5.2: no heartbeat → never_seen; a clean stop at or after the last beat → stopped; a beat within
 * `staleAfterMs` (inclusive) → running; otherwise stale (crashed, hung, or the machine slept).
 */
export function workerState(beat: Heartbeat | null, now: Date, staleAfterMs: number): WorkerState {
  if (!beat) return "never_seen";
  const beatAt = Date.parse(beat.beatAt);
  if (Number.isNaN(beatAt)) return "stale";
  if (beat.stoppedAt !== null && Date.parse(beat.stoppedAt) >= beatAt) return "stopped";
  return now.getTime() - beatAt <= staleAfterMs ? "running" : "stale";
}

const CODE = /^[a-z_]+(:[a-z0-9_]+)?$/;

/**
 * BullMQ stores a failed job's raw `error.message`, which can carry content. Only reasons shaped like our own error
 * codes (e.g. `no_active_goal`) are shown; anything else is withheld (null → "see the worker log").
 */
export function failureCode(reason: string | undefined | null): string | null {
  return typeof reason === "string" && reason.length <= 80 && CODE.test(reason) ? reason : null;
}
