import { describe, it, expect, vi } from "vitest";
import { Redactor } from "./redactor";
import { createRedactionRefresher } from "./refresher";
import type { Logger } from "./logger";

const silentLogger = (): Logger & { error: ReturnType<typeof vi.fn> } => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("createRedactionRefresher", () => {
  it("loads values into the redactor on refresh", async () => {
    const redactor = new Redactor();
    const refresher = createRedactionRefresher(redactor, async () => ["Jane Doe"], { logger: silentLogger() });
    await refresher.refresh();
    expect(redactor.redact("Jane Doe")).toBe("[REDACTED]");
  });

  it("refreshIfStale loads on first use, then not again until maxAgeMs has passed", async () => {
    let now = 1_000;
    const load = vi.fn(async () => ["Jane Doe"]);
    const refresher = createRedactionRefresher(new Redactor(), load, { maxAgeMs: 60_000, now: () => now, logger: silentLogger() });
    await refresher.refreshIfStale();
    await refresher.refreshIfStale();
    expect(load).toHaveBeenCalledTimes(1);
    now += 60_001;
    await refresher.refreshIfStale();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    let release!: (v: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>((resolve) => (release = resolve)));
    const refresher = createRedactionRefresher(new Redactor(), load, { logger: silentLogger() });
    const a = refresher.refreshIfStale();
    const b = refresher.refreshIfStale();
    release(["x y z"]);
    await Promise.all([a, b]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous values and logs only the error name when a load fails, without throwing", async () => {
    const redactor = new Redactor();
    const logger = silentLogger();
    let fail = false;
    const refresher = createRedactionRefresher(
      redactor,
      async () => {
        if (fail) throw new Error("connection refused for Jane Doe SENTINEL");
        return ["Jane Doe"];
      },
      { logger }
    );
    await refresher.refresh();
    fail = true;
    await expect(refresher.refresh()).resolves.toBeUndefined();
    expect(redactor.redact("Jane Doe")).toBe("[REDACTED]");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("redaction_refresh_failed", { error: expect.any(Error) });
  });

  it("retries a failed load on the next refreshIfStale", async () => {
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return ["Jane Doe"];
    });
    const redactor = new Redactor();
    const refresher = createRedactionRefresher(redactor, load, { logger: silentLogger() });
    await refresher.refreshIfStale();
    await refresher.refreshIfStale();
    expect(load).toHaveBeenCalledTimes(2);
    expect(redactor.redact("Jane Doe")).toBe("[REDACTED]");
  });

  it("startInterval refreshes on a timer that does not keep the process alive, and stops", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async () => ["Jane Doe"]);
      const refresher = createRedactionRefresher(new Redactor(), load, { logger: silentLogger() });
      const stop = refresher.startInterval(1000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(load).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
