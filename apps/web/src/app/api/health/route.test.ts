import { describe, it, expect, vi, beforeEach } from "vitest";

const { envState } = vi.hoisted(() => ({ envState: { current: {} as Record<string, unknown> } }));
vi.mock("@ai-career/config", () => ({ loadEnv: () => envState.current }));
const BASE_ENV = { REDIS_URL: "redis://localhost:6379" };
beforeEach(() => {
  envState.current = { ...BASE_ENV };
});

vi.mock("@ai-career/db", () => ({
  createDbClient: () => ({
    execute: vi.fn().mockResolvedValue([{ ok: 1 }]),
  }),
  closeDbClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("ioredis", () => ({
  default: class {
    async ping() {
      return "PONG";
    }
  },
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns ok when database and redis both respond", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      checks: { database: true, redis: true },
      aiUsage: { langfuseEnabled: false, langfuseExportFailures: 0 },
    });
  });

  it("reports Langfuse export as enabled when it is configured, without affecting status", async () => {
    envState.current = {
      ...BASE_ENV, LANGFUSE_HOST: "https://cloud.langfuse.com", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk",
    };
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).aiUsage).toEqual({ langfuseEnabled: true, langfuseExportFailures: 0 });
  });
});
