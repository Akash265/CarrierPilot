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

  it("backs off after a failed load: no retry until maxAgeMs has passed, then one", async () => {
    let now = 0;
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return ["Jane Doe"];
    });
    const logger = silentLogger();
    const redactor = new Redactor();
    const refresher = createRedactionRefresher(redactor, load, { logger, maxAgeMs: 60_000, now: () => now });
    await refresher.refreshIfStale();
    now += 30_000;
    await refresher.refreshIfStale();
    expect(load).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    now += 30_001;
    await refresher.refreshIfStale();
    expect(load).toHaveBeenCalledTimes(2);
    expect(redactor.redact("Jane Doe")).toBe("[REDACTED]");
  });

  it("gives up on a load that takes longer than loadTimeoutMs, keeping the previous values", async () => {
    const redactor = new Redactor();
    const logger = silentLogger();
    let hang = false;
    const load = vi.fn(() => (hang ? new Promise<string[]>(() => undefined) : Promise.resolve(["Jane Doe"])));
    const refresher = createRedactionRefresher(redactor, load, { logger, loadTimeoutMs: 20 });
    await refresher.refresh();
    hang = true;
    const started = Date.now();
    await refresher.refresh();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(redactor.redact("Jane Doe")).toBe("[REDACTED]");
    expect(logger.error).toHaveBeenCalledWith("redaction_refresh_failed", { error: expect.objectContaining({ name: "RedactionLoadTimeout" }) });
  });

  it("an invalidate during an in-flight load still forces the next refreshIfStale to reload", async () => {
    let release!: (v: string[]) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<string[]>((r) => (release = r))).mockResolvedValue(["Bob Jones"]);
    const refresher = createRedactionRefresher(new Redactor(), load, { logger: silentLogger(), maxAgeMs: 60_000, now: () => 0 });
    const first = refresher.refreshIfStale();
    refresher.invalidate();
    release(["Jane Doe"]);
    await first;
    await refresher.refreshIfStale();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("still applies a load that lands after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const redactor = new Redactor();
      let release!: (v: string[]) => void;
      const load = vi.fn(() => new Promise<string[]>((r) => (release = r)));
      const refresher = createRedactionRefresher(redactor, load, { logger: silentLogger(), loadTimeoutMs: 100 });

      const pending = refresher.refresh();
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(redactor.redact("Jane Doe")).toBe("Jane Doe");
      release(["Jane Doe"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(redactor.redact("Jane Doe")).toBe("[REDACTED]");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a timed-out load overwrite a newer load that already succeeded", async () => {
    vi.useFakeTimers();
    try {
      const redactor = new Redactor();
      let releaseSlow!: (v: string[]) => void;
      const load = vi.fn()
        .mockImplementationOnce(() => new Promise<string[]>((r) => (releaseSlow = r)))
        .mockResolvedValueOnce(["Bob Jones"]);
      const refresher = createRedactionRefresher(redactor, load, { logger: silentLogger(), loadTimeoutMs: 100 });

      const slow = refresher.refresh();
      await vi.advanceTimersByTimeAsync(100);
      await slow;
      await refresher.refresh();
      expect(redactor.redact("Bob Jones")).toBe("[REDACTED]");

      releaseSlow(["Jane Doe"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(redactor.redact("Bob Jones")).toBe("[REDACTED]");
      expect(redactor.redact("Jane Doe")).toBe("Jane Doe");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate makes the next refreshIfStale reload at once (e.g. after a profile edit)", async () => {
    const load = vi.fn(async () => ["Jane Doe"]);
    const refresher = createRedactionRefresher(new Redactor(), load, { logger: silentLogger(), maxAgeMs: 60_000, now: () => 0 });
    await refresher.refreshIfStale();
    refresher.invalidate();
    await refresher.refreshIfStale();
    expect(load).toHaveBeenCalledTimes(2);
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
