import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { throttleErrorLog } from "./throttle";

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("throttleErrorLog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("logs the first error at once, then one count of the rest when the window ends", async () => {
    const log = logger();
    const onError = throttleErrorLog(log, "worker_error", { windowMs: 1000 });
    const first = new Error("ECONNREFUSED");
    onError(first);
    for (let i = 0; i < 4; i++) onError(new Error("ECONNREFUSED"));
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("worker_error", { error: first });
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenLastCalledWith("worker_error_suppressed", { count: 4, windowMs: 1000 });
  });

  it("logs no summary when nothing was suppressed, and logs the next error in full after the window", async () => {
    const log = logger();
    const onError = throttleErrorLog(log, "worker_error", { windowMs: 1000 });
    onError(new Error("a"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.error).toHaveBeenCalledTimes(1);
    const later = new Error("b");
    onError(later);
    expect(log.error).toHaveBeenLastCalledWith("worker_error", { error: later });
  });

  it("defaults to a 60 s window", async () => {
    const log = logger();
    const onError = throttleErrorLog(log, "worker_error");
    onError(new Error("a"));
    onError(new Error("b"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(log.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(log.error).toHaveBeenLastCalledWith("worker_error_suppressed", { count: 1, windowMs: 60_000 });
  });

  it("does not keep the process alive for the summary timer", () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      throttleErrorLog(logger(), "worker_error")(new Error("a"));
      const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      clearTimeout(timer);
    } finally {
      spy.mockRestore();
    }
  });
});
