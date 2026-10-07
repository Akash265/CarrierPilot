import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { configureLogging, createLogger, defaultRedactor } from "./logger";
import { initProcessLogging } from "./processLogging";

// initProcessLogging installs process-level crash handlers; remove whatever a test added so no handler (and no
// real process.exit) outlives its test.
let listenersBefore = { exc: process.listeners("uncaughtException"), rej: process.listeners("unhandledRejection") };
beforeEach(() => {
  listenersBefore = { exc: process.listeners("uncaughtException"), rej: process.listeners("unhandledRejection") };
});

afterEach(() => {
  for (const l of process.listeners("uncaughtException")) if (!listenersBefore.exc.includes(l)) process.removeListener("uncaughtException", l);
  for (const l of process.listeners("unhandledRejection")) if (!listenersBefore.rej.includes(l)) process.removeListener("unhandledRejection", l);
  configureLogging({ level: "info" });
  defaultRedactor().setValues([]);
  vi.useRealTimers();
});

describe("initProcessLogging", () => {
  it("sets the process level, loads the D9 values before returning, and refreshes them on an interval", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const log = createLogger({ service: "worker", write: (raw) => lines.push(raw) });
    let values = ["Jane Doe"];
    const load = vi.fn(async () => values);

    const stop = await initProcessLogging({ level: "warn", load, logger: log, intervalMs: 1000 });
    log.info("dropped");
    log.warn("kept", { who: "Jane Doe" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ who: "[REDACTED]" });

    values = ["Bob Jones"];
    await vi.advanceTimersByTimeAsync(1000);
    log.warn("again", { who: "Bob Jones" });
    expect(JSON.parse(lines[1])).toMatchObject({ who: "[REDACTED]" });

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("still starts when the first load fails (email pattern only until a load succeeds)", async () => {
    const lines: string[] = [];
    const log = createLogger({ service: "worker", write: (raw) => lines.push(raw) });
    const stop = await initProcessLogging({ level: "info", load: async () => { throw new Error("db down"); }, logger: log });
    expect(JSON.parse(lines[0])).toMatchObject({ event: "redaction_refresh_failed", error: { name: "Error" } });
    stop();
  });
});

describe("initProcessLogging crash handlers (final-review fix)", () => {
  it("logs an uncaught exception or unhandled rejection without its message, then exits 1", async () => {
    const before = { exc: process.listeners("uncaughtException"), rej: process.listeners("unhandledRejection") };
    const lines: string[] = [];
    const log = createLogger({ service: "worker", write: (raw) => lines.push(raw) });
    const exit = vi.fn();
    const stop = await initProcessLogging({ level: "info", load: async () => [], logger: log, exit });
    const added = {
      exc: process.listeners("uncaughtException").filter((l) => !before.exc.includes(l)),
      rej: process.listeners("unhandledRejection").filter((l) => !before.rej.includes(l)),
    };
    try {
      expect(added.exc).toHaveLength(1);
      expect(added.rej).toHaveLength(1);
      (added.exc[0] as (e: Error) => void)(new TypeError("SENTINEL resume text"));
      (added.rej[0] as (r: unknown) => void)(new RangeError("SENTINEL job text"));
      expect(lines.map((l) => JSON.parse(l))).toEqual([
        expect.objectContaining({ level: "error", event: "uncaught_exception", error: expect.objectContaining({ name: "TypeError" }) }),
        expect.objectContaining({ level: "error", event: "unhandled_rejection", error: expect.objectContaining({ name: "RangeError" }) }),
      ]);
      expect(lines.join("")).not.toContain("SENTINEL");
      expect(exit).toHaveBeenNthCalledWith(1, 1);
      expect(exit).toHaveBeenNthCalledWith(2, 1);
    } finally {
      stop();
      for (const l of added.exc) process.removeListener("uncaughtException", l as never);
      for (const l of added.rej) process.removeListener("unhandledRejection", l as never);
    }
  });

  it("installs the handlers once, however often it is called", async () => {
    const before = process.listeners("uncaughtException").length;
    const log = createLogger({ service: "worker", write: () => undefined });
    const stops = [
      await initProcessLogging({ level: "info", load: async () => [], logger: log, exit: vi.fn() }),
      await initProcessLogging({ level: "info", load: async () => [], logger: log, exit: vi.fn() }),
    ];
    const added = process.listeners("uncaughtException").slice(before);
    const addedRej = process.listeners("unhandledRejection").slice(-added.length || undefined);
    expect(added.length).toBe(1);
    stops.forEach((s) => s());
    for (const l of added) process.removeListener("uncaughtException", l as never);
    if (added.length) for (const l of addedRej) process.removeListener("unhandledRejection", l as never);
  });
});
