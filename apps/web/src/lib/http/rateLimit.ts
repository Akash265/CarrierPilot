import IORedis from "ioredis";
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { throttleErrorLog } from "@ai-career/logging";
import { log } from "../log";

/**
 * Phase 11c design §2.3 (D178). A fixed 60 s window per route, counted in Redis (one user, so no per-client key).
 * Over the limit → 429 with Retry-After. If the counter cannot be read the request is allowed: the limit only guards
 * against runaway loops, and the 11a monthly AI budget remains the hard stop.
 */
export type RateLimitBucket = "ai" | "jobs" | "unlock" | "health";

export interface CounterStore {
  /** Increments the key's count (expiring it after the window) and returns the new count. */
  hit(key: string, windowMs: number): Promise<number>;
}

export interface RateLimitDeps {
  store: () => CounterStore;
  limits: () => Record<RateLimitBucket, number>;
  now?: () => number;
  onUnavailable: (error: unknown) => void;
}

const WINDOW_MS = 60_000;
const UNLOCK_PER_MINUTE = 5;
/** /api/health needs no token and opens a DB and a Redis connection per call; monitors poll far slower than this. */
const HEALTH_PER_MINUTE = 60;

export function makeWithRateLimit(deps: RateLimitDeps) {
  const now = deps.now ?? Date.now;
  return function withRateLimit<A extends unknown[]>(
    bucket: RateLimitBucket, route: string, handler: (...args: A) => Promise<Response>,
  ): (...args: A) => Promise<Response> {
    return async (...args: A) => {
      const limit = deps.limits()[bucket];
      if (limit > 0) {
        const at = now();
        const window = Math.floor(at / WINDOW_MS);
        let count: number;
        try {
          count = await deps.store().hit(`careerpilot:rl:${route}:${window}`, WINDOW_MS);
        } catch (error) {
          deps.onUnavailable(error);
          return handler(...args);
        }
        if (count > limit) {
          const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * WINDOW_MS - at) / 1000));
          return NextResponse.json(
            { error: `Too many requests — try again in ${retryAfterSeconds} s.`, retryAfterSeconds },
            { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
          );
        }
      }
      return handler(...args);
    };
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rate limit store timeout")), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let connection: IORedis | null = null;

/** One long-lived connection per web process; a slow or absent Redis costs a request at most 500 ms. */
export const redisStore: CounterStore = {
  async hit(key, windowMs) {
    connection ??= (() => {
      const c = new IORedis(loadEnv().REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1000, retryStrategy: (n) => Math.min(n * 200, 2000) });
      c.on("error", () => undefined); // reported per request through onUnavailable
      return c;
    })();
    const result = await withTimeout(connection.multi().incr(key).pexpire(key, windowMs + 1000).exec(), 500);
    const [incr, expire] = result ?? [];
    if (!incr || incr[0]) throw incr?.[0] ?? new Error("rate limit store returned no result");
    // A key without an expiry would count forever; treat that like an unavailable store (the request is allowed).
    if (!expire || expire[0]) throw expire?.[0] ?? new Error("rate limit store did not set the expiry");
    return Number(incr[1]);
  },
};

let cachedLimits: Record<RateLimitBucket, number> | null = null;

function envLimits(): Record<RateLimitBucket, number> {
  if (cachedLimits) return cachedLimits;
  try {
    const env = loadEnv();
    cachedLimits = { ai: env.RATE_LIMIT_AI_PER_MINUTE, jobs: env.RATE_LIMIT_JOBS_PER_MINUTE, unlock: UNLOCK_PER_MINUTE, health: HEALTH_PER_MINUTE };
    return cachedLimits;
  } catch {
    // Invalid configuration: the route itself answers for that; only the unlock guard still applies.
    return { ai: 0, jobs: 0, unlock: UNLOCK_PER_MINUTE, health: HEALTH_PER_MINUTE };
  }
}

export const withRateLimit = makeWithRateLimit({
  store: () => redisStore,
  limits: envLimits,
  onUnavailable: throttleErrorLog(log, "rate_limit_unavailable"),
});
