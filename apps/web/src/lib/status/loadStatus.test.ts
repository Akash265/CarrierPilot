import { describe, it, expect } from "vitest";
import { loadStatus, type StatusEnv } from "./loadStatus";

// Closed ports: if the injected checks were ignored, the real ones would fail fast instead of hanging.
const ENV: StatusEnv = { DATABASE_URL: "postgres://x:x@127.0.0.1:5999/x", REDIS_URL: "redis://127.0.0.1:5998", STATUS_STALE_AFTER_MS: 90_000 };

describe("loadStatus", () => {
  it("starts the Redis check before the database check finishes, so two hanging services cost one timeout", async () => {
    const started: string[] = [];
    let finishDatabase!: () => void;
    let finishRedis!: () => void;
    const report = loadStatus(ENV, new Date("2026-10-07T12:00:00Z"), {
      checkDatabase: () => {
        started.push("database");
        return new Promise((r) => (finishDatabase = () => r("ok")));
      },
      checkRedis: () => {
        started.push("redis");
        return new Promise((r) => (finishRedis = () => r({ redis: "ok", workers: [], queues: [] })));
      },
    });
    await Promise.resolve();
    expect(started).toEqual(["database", "redis"]);
    finishRedis();
    finishDatabase();
    expect(await report).toEqual({ checkedAt: "2026-10-07T12:00:00.000Z", database: "ok", redis: "ok", workers: [], queues: [] });
  });
});
