import IORedis from "ioredis";
import { loadEnv } from "@ai-career/config";
import { DbUsageSink, closeDbClient, createDbClient } from "@ai-career/db";
import { createAnthropicFor, withLangfuseExport, type AiUsageSink } from "@ai-career/ai";
import { createMatchingWorker } from "./worker";

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

const safeErrorLabel = (error: unknown): string =>
  error instanceof Error && (error.name === "UnrecoverableError" || error.name === "MatchingError")
    ? error.message
    : error instanceof Error
      ? error.name
      : "unknown";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const aiFor = (userId: string) => {
    // Typed as AiUsageSink so the compiler checks DbUsageSink still matches the AI package's interface.
    const usageSink: AiUsageSink = withLangfuseExport(new DbUsageSink(db, userId), env);
    return { usageSink, anthropicFor: createAnthropicFor(env, usageSink) };
  };

  const worker = createMatchingWorker({ connection, db, aiFor, env });
  worker.on("completed", (job) => log("matching_completed", { jobId: job.id }));
  worker.on("failed", (job, error) => log("matching_failed", { jobId: job?.id, error: safeErrorLabel(error) }));
  log("worker_started", {});

  const shutdown = async () => {
    await worker.close();
    await connection.quit();
    await closeDbClient(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log("worker_crashed", { error: safeErrorLabel(error) });
  process.exit(1);
});
