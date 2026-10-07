import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { startHeartbeat } from "./heartbeat";
import { readWorkerStatus } from "./status";

const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const prefix = `test-${randomUUID()}:worker:`;

beforeAll(() => redis.ping());
afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

describe("startHeartbeat / readWorkerStatus", () => {
  it("reports every known worker, never_seen before any heartbeat, with optional flags", async () => {
    const statuses = await readWorkerStatus(redis, new Date(), { keyPrefix: prefix, staleAfterMs: 90_000 });
    expect(statuses.map((s) => [s.worker, s.optional, s.state])).toEqual([
      ["job-ingestion", false, "never_seen"],
      ["matching", false, "never_seen"],
      ["maintenance", true, "never_seen"],
      ["browser", true, "never_seen"],
    ]);
  });

  it("writes immediately, beats on an interval, and records a clean stop", async () => {
    let now = new Date("2026-10-07T12:00:00.000Z");
    const heartbeat = await startHeartbeat(redis, "matching", { keyPrefix: prefix, intervalMs: 20, now: () => now });
    const first = JSON.parse((await redis.get(`${prefix}matching`))!);
    expect(first).toEqual({ startedAt: "2026-10-07T12:00:00.000Z", beatAt: "2026-10-07T12:00:00.000Z", pid: process.pid, stoppedAt: null });

    now = new Date("2026-10-07T12:00:30.000Z");
    await vi.waitFor(async () => expect(JSON.parse((await redis.get(`${prefix}matching`))!).beatAt).toBe("2026-10-07T12:00:30.000Z"));
    let [, matching] = await readWorkerStatus(redis, now, { keyPrefix: prefix, staleAfterMs: 90_000 });
    expect(matching).toMatchObject({ worker: "matching", state: "running", startedAt: "2026-10-07T12:00:00.000Z", lastSeenAt: "2026-10-07T12:00:30.000Z", stoppedAt: null });

    now = new Date("2026-10-07T12:01:00.000Z");
    await heartbeat.stop();
    [, matching] = await readWorkerStatus(redis, new Date("2026-10-07T15:00:00.000Z"), { keyPrefix: prefix, staleAfterMs: 90_000 });
    expect(matching).toMatchObject({ state: "stopped", stoppedAt: "2026-10-07T12:01:00.000Z", lastSeenAt: "2026-10-07T12:01:00.000Z" });

    // No beats after stop.
    const afterStop = await redis.get(`${prefix}matching`);
    await new Promise((r) => setTimeout(r, 60));
    expect(await redis.get(`${prefix}matching`)).toBe(afterStop);
  });

  it("shows a worker that died without stopping as stale once the threshold passes", async () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const heartbeat = await startHeartbeat(redis, "job-ingestion", { keyPrefix: prefix, intervalMs: 60_000, now: () => now });
    const statuses = await readWorkerStatus(redis, new Date(now.getTime() + 5_001), { keyPrefix: prefix, staleAfterMs: 5_000 });
    expect(statuses[0]).toMatchObject({ worker: "job-ingestion", state: "stale" });
    await heartbeat.stop();
  });

  it("treats a malformed stored value as stale with no times", async () => {
    await redis.set(`${prefix}maintenance`, "{not json");
    const statuses = await readWorkerStatus(redis, new Date(), { keyPrefix: prefix, staleAfterMs: 90_000 });
    expect(statuses[2]).toEqual({ worker: "maintenance", optional: true, state: "stale", startedAt: null, lastSeenAt: null, stoppedAt: null });
  });

  it("never throws when Redis rejects a write, and logs only the error name", async () => {
    const failing = { set: async () => { throw new Error("READONLY You can't write against a read only replica SENTINEL"); } };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const heartbeat = await startHeartbeat(failing, "browser", { keyPrefix: prefix, intervalMs: 60_000, logger });
    await expect(heartbeat.stop()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("heartbeat_failed", { worker: "browser", error: expect.any(Error) });
  });

  it("stop() gives up after stopTimeoutMs when Redis never answers, and never throws", async () => {
    const hanging = { set: vi.fn((): Promise<unknown> => new Promise(() => undefined)) };
    hanging.set.mockImplementationOnce(async () => "OK");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const heartbeat = await startHeartbeat(hanging, "browser", { keyPrefix: prefix, intervalMs: 60_000, stopTimeoutMs: 20, logger });
    const started = Date.now();
    await expect(heartbeat.stop()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logger.error).toHaveBeenCalledWith("heartbeat_failed", { worker: "browser", error: expect.objectContaining({ name: "HeartbeatTimeout" }) });
  });
});
