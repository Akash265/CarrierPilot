import { describe, it, expect } from "vitest";
import { configureLogging, createLogger, defaultRedactor, type LogLevel } from "./logger";
import { Redactor } from "./redactor";

function capture(level?: LogLevel, redactor?: Redactor) {
  const lines: { level: LogLevel; obj: Record<string, unknown>; raw: string }[] = [];
  const log = createLogger({ service: "test-svc", level, redactor, write: (raw, lvl) => lines.push({ level: lvl, obj: JSON.parse(raw), raw }) });
  return { log, lines };
}

describe("createLogger", () => {
  it("writes one JSON line with ts, level, service, event and the fields", () => {
    const { log, lines } = capture();
    log.info("matching_completed", { jobId: "42", count: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0].obj).toEqual({ ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), level: "info", service: "test-svc", event: "matching_completed", jobId: "42", count: 3 });
    expect(lines[0].raw).not.toContain("\n");
  });

  it("filters below the configured level (default info)", () => {
    const { log, lines } = capture();
    log.debug("noisy");
    log.warn("careful");
    expect(lines.map((l) => l.obj.event)).toEqual(["careful"]);
    const debug = capture("debug");
    debug.log.debug("noisy");
    expect(debug.lines).toHaveLength(1);
    const errorOnly = capture("error");
    errorOnly.log.warn("careful");
    errorOnly.log.error("broken");
    expect(errorOnly.lines.map((l) => l.obj.event)).toEqual(["broken"]);
  });

  it("does not let fields overwrite ts, level, service or event", () => {
    const { log, lines } = capture();
    log.error("real_event", { event: "fake", level: "debug", service: "other", ts: "x", keep: 1 });
    expect(lines[0].obj).toMatchObject({ event: "real_event", level: "error", service: "test-svc", keep: 1 });
    expect(lines[0].obj.ts).not.toBe("x");
  });

  it("scrubs string fields with the redactor and never writes error messages", () => {
    const redactor = new Redactor();
    redactor.setValues(["Jane Doe"]);
    const { log, lines } = capture(undefined, redactor);
    const err = new Error("duplicate key: Jane Doe SENTINEL");
    log.error("request_failed", { path: "/api/profile/Jane Doe", error: err });
    expect(lines[0].raw).not.toContain("Jane Doe");
    expect(lines[0].raw).not.toContain("SENTINEL");
    expect(lines[0].obj).toMatchObject({ path: "/api/profile/[REDACTED]", error: { name: "Error" } });
  });

  it("routes warn and error to stderr and the rest to stdout by default", () => {
    const writes: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (writes.push(`out:${chunk}`), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (writes.push(`err:${chunk}`), true)) as typeof process.stderr.write;
    try {
      const log = createLogger({ service: "s" });
      log.info("a");
      log.warn("b");
      log.error("c");
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(writes.map((w) => w.slice(0, 4))).toEqual(["out:", "err:", "err:"]);
    expect(writes.every((w) => w.endsWith("\n"))).toBe(true);
  });

  it("never throws, even when a write fails", () => {
    const log = createLogger({ service: "s", write: () => { throw new Error("EPIPE"); } });
    expect(() => log.error("x", { a: 1 })).not.toThrow();
  });

  it("uses the process-wide level and redactor from configureLogging, read at write time", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "lib", write: (raw) => lines.push(raw) });
    try {
      configureLogging({ level: "error" });
      log.warn("dropped");
      defaultRedactor().setValues(["Jane Doe"]);
      log.error("kept", { who: "Jane Doe" });
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ event: "kept", who: "[REDACTED]" });
    } finally {
      configureLogging({ level: "info" });
      defaultRedactor().setValues([]);
    }
  });

  it("lets a logger's own options override the process-wide ones", () => {
    const lines: string[] = [];
    const own = new Redactor();
    const log = createLogger({ service: "x", level: "debug", redactor: own, write: (raw) => lines.push(raw) });
    try {
      configureLogging({ level: "error" });
      defaultRedactor().setValues(["Jane Doe"]);
      log.debug("kept", { who: "Jane Doe" });
      expect(JSON.parse(lines[0])).toMatchObject({ who: "Jane Doe" });
    } finally {
      configureLogging({ level: "info" });
      defaultRedactor().setValues([]);
    }
  });
});
