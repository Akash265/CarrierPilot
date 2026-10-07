import type { Logger } from "./logger";

export interface ThrottleOptions {
  /** How long after a logged error further ones are only counted (default 60 s). */
  windowMs?: number;
}

/**
 * Phase 11b review fix (D175). A BullMQ worker emits 'error' for every failed reconnect while Redis is down -- many a
 * second for as long as the outage lasts. This logs the first error in full, counts the rest for `windowMs`, then logs
 * one `<event>_suppressed` line with the count, so an outage is visible without flooding the log. The window timer is
 * unref'd: it never keeps a stopping process alive.
 */
export function throttleErrorLog(logger: Logger, event: string, opts: ThrottleOptions = {}): (error: unknown) => void {
  const windowMs = opts.windowMs ?? 60_000;
  let windowOpen = false;
  let suppressed = 0;
  return (error) => {
    if (windowOpen) {
      suppressed++;
      return;
    }
    logger.error(event, { error });
    windowOpen = true;
    const timer = setTimeout(() => {
      if (suppressed > 0) logger.error(`${event}_suppressed`, { count: suppressed, windowMs });
      suppressed = 0;
      windowOpen = false;
    }, windowMs);
    timer.unref?.();
  };
}
