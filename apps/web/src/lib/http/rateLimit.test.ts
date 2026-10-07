import { describe, it, expect, vi } from "vitest";
import { makeWithRateLimit, type CounterStore } from "./rateLimit";

function memoryStore(): CounterStore & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async hit(key) {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    },
  };
}

const ok = async () => new Response("ok");

function setup(over: { limit?: number; store?: CounterStore; now?: () => number } = {}) {
  const onUnavailable = vi.fn();
  const store = over.store ?? memoryStore();
  const withRateLimit = makeWithRateLimit({
    store: () => store,
    limits: () => ({ ai: over.limit ?? 2, jobs: 5, unlock: 5 }),
    now: over.now ?? (() => 90_000),
    onUnavailable,
  });
  return { withRateLimit, onUnavailable, store };
}

describe("withRateLimit", () => {
  it("lets requests through up to the limit, then answers 429 with Retry-After until the window ends", async () => {
    const { withRateLimit } = setup();
    const handler = withRateLimit("ai", "/api/career-goal/parse", ok);
    expect((await handler()).status).toBe(200);
    expect((await handler()).status).toBe(200);
    const limited = await handler();
    expect(limited.status).toBe(429);
    // now = 90 s: the 60 s window started at 60 s and ends at 120 s.
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(await limited.json()).toEqual({ error: "Too many requests — try again in 30 s.", retryAfterSeconds: 30 });
  });

  it("counts each route separately, keyed by route and window", async () => {
    const { withRateLimit, store } = setup({ limit: 1 });
    expect((await withRateLimit("ai", "/api/a", ok)()).status).toBe(200);
    expect((await withRateLimit("ai", "/api/b", ok)()).status).toBe(200);
    expect((store as ReturnType<typeof memoryStore>).keys).toEqual(["careerpilot:rl:/api/a:1", "careerpilot:rl:/api/b:1"]);
  });

  it("starts a fresh count in the next window", async () => {
    let now = 60_000;
    const { withRateLimit } = setup({ limit: 1, now: () => now });
    const handler = withRateLimit("ai", "/api/a", ok);
    expect((await handler()).status).toBe(200);
    expect((await handler()).status).toBe(429);
    now = 120_000;
    expect((await handler()).status).toBe(200);
  });

  it("never limits when the bucket's limit is 0, and does not touch the store", async () => {
    const store = { hit: vi.fn(async () => 999) };
    const { withRateLimit } = setup({ limit: 0, store });
    expect((await withRateLimit("ai", "/api/a", ok)()).status).toBe(200);
    expect(store.hit).not.toHaveBeenCalled();
  });

  it("allows the request and reports it when the counter store fails (the AI budget is the hard stop)", async () => {
    const failure = new Error("Connection is closed");
    const { withRateLimit, onUnavailable } = setup({ store: { hit: async () => { throw failure; } } });
    expect((await withRateLimit("jobs", "/api/matches/run", ok)()).status).toBe(200);
    expect(onUnavailable).toHaveBeenCalledWith(failure);
  });

  it("passes the handler's arguments through", async () => {
    const { withRateLimit } = setup();
    const handler = withRateLimit("ai", "/api/a", async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
      Response.json({ url: req.url, id: (await ctx.params).id }));
    const res = await handler(new Request("http://localhost/x"), { params: Promise.resolve({ id: "7" }) });
    expect(await res.json()).toEqual({ url: "http://localhost/x", id: "7" });
  });
});

describe("redisStore (real Redis)", () => {
  it("counts per key and expires the key after the window", async () => {
    const { redisStore } = await import("./rateLimit");
    const IORedis = (await import("ioredis")).default;
    const { loadEnv } = await import("@ai-career/config");
    const key = `careerpilot:rl:test:${process.pid}:${Date.now()}`;
    expect(await redisStore.hit(key, 60_000)).toBe(1);
    expect(await redisStore.hit(key, 60_000)).toBe(2);
    const redis = new IORedis(loadEnv().REDIS_URL);
    try {
      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(55_000);
      expect(ttl).toBeLessThanOrEqual(61_000);
      await redis.del(key);
    } finally {
      redis.disconnect();
    }
  });
});
