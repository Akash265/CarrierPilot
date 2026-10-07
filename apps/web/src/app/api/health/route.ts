import { NextResponse } from "next/server";
import { createDbClient, closeDbClient } from "@ai-career/db";
import { sql } from "drizzle-orm";
import Redis from "ioredis";
import { loadEnv } from "@ai-career/config";
import { getLangfuseExportFailures, isLangfuseConfigured } from "@ai-career/ai";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

async function handleGET() {
  const env = loadEnv();
  const checks = { database: false, redis: false };

  try {
    const db = createDbClient(env);
    try {
      await db.execute(sql`SELECT 1`);
      checks.database = true;
    } finally {
      // This route is polled repeatedly by CI/deploy smoke checks, so the
      // pool must be closed every time or it leaks connections and
      // eventually exhausts Postgres's connection limit on the exact
      // endpoint meant to prove liveness.
      await closeDbClient(db);
    }
  } catch {
    checks.database = false;
  }

  try {
    // lazyConnect defers connecting until the first command (ping), so no
    // explicit `.connect()` call is needed here.
    const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const pong = await redis.ping();
    checks.redis = pong === "PONG";
    try {
      redis.disconnect();
    } catch {
      // Best-effort cleanup only; must not affect the check result above.
    }
  } catch {
    checks.redis = false;
  }

  const status = checks.database && checks.redis ? "ok" : "degraded";
  // Phase 11a: informational only -- Langfuse is optional, so its health never changes `status`. The
  // failure count is this web process's own exports since it started (each worker process has its own).
  const aiUsage = { langfuseEnabled: isLangfuseConfigured(env), langfuseExportFailures: getLangfuseExportFailures() };
  return NextResponse.json({ status, checks, aiUsage }, { status: status === "ok" ? 200 : 503 });
}

export const GET = withRouteErrors("/api/health", handleGET);
