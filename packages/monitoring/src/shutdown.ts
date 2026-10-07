import type { Logger } from "@ai-career/logging";

export interface ShutdownOptions {
  logger: Logger;
  /** Closes the worker, queues, heartbeat, Redis and the database, in order. */
  steps: () => Promise<void>;
  /** After this, the process exits 1 even if a step is still waiting (default 10 s). */
  timeoutMs?: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
}

/**
 * Phase 11b review fix (D174). A worker's SIGINT/SIGTERM handler: runs `steps` exactly once however many signals
 * arrive (a double Ctrl-C, or a wrapper forwarding the signal), then exits 0. A failing step is logged message-free
 * and exits 1; a step that never finishes -- `quit()` and every Redis command wait forever while Redis is unreachable,
 * because workers need `maxRetriesPerRequest: null` -- is cut off after `timeoutMs` with exit 1.
 */
export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let running: Promise<void> | null = null;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  return () => {
    if (running) return running;
    const deadline = setTimeout(() => {
      opts.logger.error("shutdown_timed_out", { timeoutMs });
      exitOnce(1);
    }, timeoutMs);
    deadline.unref?.();
    running = (async () => {
      try {
        await opts.steps();
        clearTimeout(deadline);
        exitOnce(0);
      } catch (error) {
        clearTimeout(deadline);
        opts.logger.error("shutdown_failed", { error });
        exitOnce(1);
      }
    })();
    return running;
  };
}
