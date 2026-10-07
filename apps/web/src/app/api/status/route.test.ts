import { describe, it, expect, vi, beforeEach } from "vitest";

const { envState } = vi.hoisted(() => ({ envState: { current: {} as Record<string, unknown> } }));
vi.mock("@ai-career/config", () => ({ loadEnv: () => envState.current }));

const BASE_ENV = {
  DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000c03",
  DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  STATUS_STALE_AFTER_MS: 90_000,
};
beforeEach(() => {
  envState.current = { ...BASE_ENV };
});

const { GET } = await import("./route");

describe("GET /api/status", () => {
  it("reports database and Redis ok, every worker, and every queue", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database).toBe("ok");
    expect(body.redis).toBe("ok");
    expect(Date.parse(body.checkedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(body.workers.map((w: { worker: string }) => w.worker)).toEqual(["job-ingestion", "matching", "maintenance", "browser"]);
    for (const w of body.workers) expect(["running", "stopped", "stale", "never_seen"]).toContain(w.state);
    expect(body.queues.map((q: { queue: string }) => q.queue)).toEqual(["job-ingestion", "matching", "maintenance", "browser-automation"]);
    for (const q of body.queues) expect(q).toEqual(expect.objectContaining({ waiting: expect.any(Number), failed: expect.any(Number) }));
  });

  it("still answers 200 when Redis is unreachable, saying so with no workers or queues", async () => {
    envState.current = { ...BASE_ENV, REDIS_URL: "redis://localhost:6390" };
    const started = Date.now();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ database: "ok", redis: "unavailable", workers: [], queues: [] });
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it("still answers 200 when the database is unreachable", async () => {
    envState.current = { ...BASE_ENV, DATABASE_URL: "postgres://career_intel_app:career_intel_app@localhost:5999/career_intel_test" };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ database: "unavailable", redis: "ok" });
  });
});
