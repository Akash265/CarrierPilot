import { loadEnv } from "@ai-career/config";
import type { Logger } from "@ai-career/logging";
import { log } from "../log";
import { isExposedWithoutToken } from "./hosts";

/** Phase 11c design §2.1 (D177): a loud line when APP_HOST opens the app to the network with nothing guarding it. */
export function warnIfExposed(env: { APP_HOST: string; APP_ACCESS_TOKEN?: string }, logger: Logger = log): void {
  if (isExposedWithoutToken(env)) logger.warn("exposed_without_token", { host: env.APP_HOST });
}

/** Called once from instrumentation's register(). An invalid configuration is reported by the first request. */
export function runStartupCheck(): void {
  try {
    warnIfExposed(loadEnv());
  } catch {
    // loadEnv already fails every route that needs the config; nothing to add here.
  }
}
