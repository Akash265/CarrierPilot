import { configureLogging, defaultRedactor, type Logger, type LogLevel } from "./logger";
import { createRedactionRefresher } from "./refresher";

export interface ProcessLoggingOptions {
  level: LogLevel;
  /** Loads the user's D9 values (e.g. `() => loadRedactionValues(db, userId)`). */
  load: () => Promise<string[]>;
  /** Where a failed load is reported (by error name only). */
  logger: Logger;
  intervalMs?: number;
}

/**
 * One call at a long-running process's start (Phase 11b design §3.4): sets the process-wide level, loads the D9
 * values into the default redactor before returning, and refreshes them every minute. Returns a stop function.
 * A failed first load does not stop the process: only the email pattern applies until a load succeeds.
 */
export async function initProcessLogging(opts: ProcessLoggingOptions): Promise<() => void> {
  configureLogging({ level: opts.level });
  const refresher = createRedactionRefresher(defaultRedactor(), opts.load, { logger: opts.logger });
  await refresher.refresh();
  return refresher.startInterval(opts.intervalMs ?? 60_000);
}
