export const BROWSER_QUEUE_NAME = "browser-automation";
export const BROWSER_JOB_NAME = "run-autofill";

export interface BrowserJobData {
  sessionId: string;
  userId: string;
}

export const browserJobId = (sessionId: string): string => `autofill-${sessionId}`;

/**
 * One attempt: a retry would open a second browser window for the same session. A stalled job that BullMQ
 * re-delivers is harmless -- the worker only claims a session still in `queued`.
 */
export const BROWSER_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: true };
