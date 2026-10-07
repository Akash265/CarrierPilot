import { configureLogging, defaultRedactor, type Logger, type LogLevel } from "./logger";
import { createRedactionRefresher } from "./refresher";

export interface ProcessLoggingOptions {
  level: LogLevel;
  /** Loads the user's D9 values (e.g. `() => loadRedactionValues(db, userId)`). */
  load: () => Promise<string[]>;
  /** Where a failed load is reported (by error name only). */
  logger: Logger;
  intervalMs?: number;
  /** Injectable for tests; the crash handlers call it with 1 after logging. */
  exit?: (code: number) => void;
}

let installed: { exception: (error: Error) => void; rejection: (reason: unknown) => void } | null = null;

/**
 * Final-review fix (D173): without these, an uncaught exception or unhandled rejection reaches Node's default
 * printer, which writes the error's stack -- message included -- to stderr. They log it message-free and exit 1, as
 * Node would. Installed once per process (while still registered), so repeated calls do not stack handlers.
 */
function installCrashHandlers(logger: Logger, exit: (code: number) => void): void {
  if (installed && process.listeners("uncaughtException").includes(installed.exception)) return;
  installed = {
    exception: (error) => {
      logger.error("uncaught_exception", { error });
      exit(1);
    },
    rejection: (reason) => {
      logger.error("unhandled_rejection", { error: reason });
      exit(1);
    },
  };
  process.on("uncaughtException", installed.exception);
  process.on("unhandledRejection", installed.rejection);
}

/**
 * One call at a long-running process's start (Phase 11b design §3.4): sets the process-wide level, loads the D9
 * values into the default redactor before returning, and refreshes them every minute. Returns a stop function.
 * A failed first load does not stop the process: only the email pattern applies until a load succeeds. Also installs
 * message-free handlers for uncaught exceptions and unhandled rejections (exit 1).
 */
export async function initProcessLogging(opts: ProcessLoggingOptions): Promise<() => void> {
  configureLogging({ level: opts.level });
  installCrashHandlers(opts.logger, opts.exit ?? ((code) => process.exit(code)));
  const refresher = createRedactionRefresher(defaultRedactor(), opts.load, { logger: opts.logger });
  await refresher.refresh();
  return refresher.startInterval(opts.intervalMs ?? 60_000);
}
