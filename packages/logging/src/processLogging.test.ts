import { describe, it, expect, vi, afterEach } from "vitest";
import { configureLogging, createLogger, defaultRedactor } from "./logger";
import { initProcessLogging } from "./processLogging";

afterEach(() => {
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
