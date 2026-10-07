import type { Logger } from "./logger";
import type { Redactor } from "./redactor";

export interface RedactionRefresher {
  /** Loads the values now. A failed load keeps the previous values, is logged by error name, and never throws. */
  refresh(): Promise<void>;
  /**
   * Refreshes only when the last attempt -- successful or not -- is older than maxAgeMs; concurrent callers share one
   * load. Counting failed attempts is the backoff: during an outage, errors do not each retry the load.
   */
  refreshIfStale(): Promise<void>;
  /** Makes the next refreshIfStale reload immediately (e.g. after the user edits their profile). */
  invalidate(): void;
  /** Refreshes every `ms` on an unref()'d timer; returns a function that stops it. */
  startInterval(ms: number): () => void;
}

export interface RefresherOptions {
  logger: Logger;
  maxAgeMs?: number;
  /** A load slower than this counts as failed (default 2 s), so a hanging database cannot stall a log line for long. */
  loadTimeoutMs?: number;
  now?: () => number;
}

class RedactionLoadTimeout extends Error {
  constructor() {
    super("redaction load timed out");
    this.name = "RedactionLoadTimeout";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedactionLoadTimeout()), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Phase 11b design §3.4: keeps a Redactor's D9 values current from the profile table. */
export function createRedactionRefresher(redactor: Redactor, load: () => Promise<string[]>, opts: RefresherOptions): RedactionRefresher {
  const maxAgeMs = opts.maxAgeMs ?? 60_000;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 2000;
  const now = opts.now ?? Date.now;
  let attemptedAt: number | null = null;
  // An invalidate that lands while a load is in flight may predate the change that load read, so it must survive it.
  let invalidatedDuringLoad = false;
  let inFlight: Promise<void> | null = null;
  // Each load is numbered. A load that times out still applies its values when it lands, unless a newer load has
  // already succeeded -- otherwise one slow query would keep the redactor on stale values until the next refresh.
  let started = 0;
  let applied = 0;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    invalidatedDuringLoad = false;
    inFlight = (async () => {
      const seq = ++started;
      try {
        const loaded = load().then((values) => {
          if (seq > applied) {
            applied = seq;
            redactor.setValues(values);
          }
        });
        await withTimeout(loaded, loadTimeoutMs);
      } catch (error) {
        opts.logger.error("redaction_refresh_failed", { error });
      } finally {
        attemptedAt = invalidatedDuringLoad ? null : now();
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    refresh,
    refreshIfStale: () => (inFlight ? inFlight : attemptedAt !== null && now() - attemptedAt <= maxAgeMs ? Promise.resolve() : refresh()),
    invalidate: () => {
      attemptedAt = null;
      if (inFlight) invalidatedDuringLoad = true;
    },
    startInterval: (ms) => {
      const timer = setInterval(() => void refresh(), ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
