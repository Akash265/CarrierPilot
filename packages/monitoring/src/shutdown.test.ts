import { describe, it, expect, vi } from "vitest";
import { createShutdown } from "./shutdown";

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("createShutdown", () => {
  it("runs the steps once and exits 0, however many signals arrive", async () => {
    const steps = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdown({ logger: logger(), steps, exit });
    await Promise.all([shutdown(), shutdown(), shutdown()]);
    expect(steps).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("logs a failing step without its message and exits 1", async () => {
    const log = logger();
    const exit = vi.fn();
    const failure = new Error("Connection is closed SENTINEL");
    await createShutdown({ logger: log, steps: async () => { throw failure; }, exit })();
    expect(log.error).toHaveBeenCalledWith("shutdown_failed", { error: failure });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 after the deadline when a step never finishes (e.g. Redis unreachable)", async () => {
    vi.useFakeTimers();
    try {
      const log = logger();
      const exit = vi.fn();
      void createShutdown({ logger: log, steps: () => new Promise<void>(() => undefined), exit, timeoutMs: 10_000 })();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(log.error).toHaveBeenCalledWith("shutdown_timed_out", { timeoutMs: 10_000 });
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not exit twice when the steps finish after the deadline fired", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const exit = vi.fn();
      const done = createShutdown({ logger: logger(), steps: () => new Promise<void>((r) => (finish = r)), exit, timeoutMs: 100 })();
      await vi.advanceTimersByTimeAsync(100);
      finish();
      await done;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
