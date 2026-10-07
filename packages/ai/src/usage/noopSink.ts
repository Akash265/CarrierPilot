import type { AiUsageSink } from "./types";

/** For evals and unit tests: never blocks (spend is always 0), records nothing. */
export const NoopUsageSink: AiUsageSink = Object.freeze({
  spendSinceUsd: async () => 0,
  record: async () => undefined,
});
