import type { Logger } from "./logger";
import type { Redactor } from "./redactor";

export interface RedactionRefresher {
  /** Loads the values now. A failed load keeps the previous values, is logged by error name, and never throws. */
  refresh(): Promise<void>;
  /** Refreshes only when the last successful load is older than maxAgeMs; concurrent callers share one load. */
  refreshIfStale(): Promise<void>;
  /** Refreshes every `ms` on an unref()'d timer; returns a function that stops it. */
  startInterval(ms: number): () => void;
}

export interface RefresherOptions {
  logger: Logger;
  maxAgeMs?: number;
  now?: () => number;
}

/** Phase 11b design §3.4: keeps a Redactor's D9 values current from the profile table. */
export function createRedactionRefresher(redactor: Redactor, load: () => Promise<string[]>, opts: RefresherOptions): RedactionRefresher {
  const maxAgeMs = opts.maxAgeMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let loadedAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        redactor.setValues(await load());
        loadedAt = now();
      } catch (error) {
        opts.logger.error("redaction_refresh_failed", { error });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    refresh,
    refreshIfStale: () => (inFlight ? inFlight : loadedAt !== null && now() - loadedAt <= maxAgeMs ? Promise.resolve() : refresh()),
    startInterval: (ms) => {
      const timer = setInterval(() => void refresh(), ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
