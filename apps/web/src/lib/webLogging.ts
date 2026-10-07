import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { configureLogging, createRedactionRefresher, defaultRedactor, type RedactionRefresher } from "@ai-career/logging";
import { log } from "./log";

let refresher: RedactionRefresher | null = null;

/**
 * Phase 11b design §3.4 for the web process: on first use, sets the process-wide log level and creates a refresher
 * for the D9 values (one short-lived DB connection per load, like every route); afterwards reloads them at most
 * once a minute. Called on the error path only -- errors are rare, and awaiting here means even the first error
 * after boot is scrubbed. Never throws: without a config or a database only the email pattern applies.
 */
export async function refreshWebRedactions(): Promise<void> {
  try {
    if (!refresher) {
      const env = loadEnv();
      configureLogging({ level: env.LOG_LEVEL });
      refresher = createRedactionRefresher(
        defaultRedactor(),
        async () => {
          const db = createDbClient(env);
          try {
            return await loadRedactionValues(db, env.DEFAULT_USER_ID);
          } finally {
            await closeDbClient(db);
          }
        },
        { logger: log }
      );
    }
    await refresher.refreshIfStale();
  } catch {
    // loadEnv failed: nothing to load from. The email pattern still applies.
  }
}
