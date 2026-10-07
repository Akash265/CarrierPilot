import { Redactor } from "./redactor";
import { sanitize } from "./sanitize";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  redactor?: Redactor;
  /** Defaults to stderr for warn/error and stdout otherwise; injectable for tests. */
  write?: (line: string, level: LogLevel) => void;
}

const RESERVED = new Set(["ts", "level", "service", "event"]);

/**
 * Process-wide defaults, read at write time: a process sets its level and loads its D9 values once
 * (`configureLogging` / `initProcessLogging`), and every logger -- including ones library modules created at import
 * time -- uses them. A logger's own `level`/`redactor` options override these.
 */
const defaults: { level: LogLevel; redactor: Redactor } = { level: "info", redactor: new Redactor() };

export function configureLogging(opts: { level?: LogLevel }): void {
  if (opts.level) defaults.level = opts.level;
}

/** The redactor every logger without its own uses; `initProcessLogging` keeps it current. */
export function defaultRedactor(): Redactor {
  return defaults.redactor;
}

function defaultWrite(line: string, level: LogLevel): void {
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

/**
 * Phase 11b design §3.1. One JSON line per event: `{ ts, level, service, event, ...fields }`, fields sanitized
 * (scrubbed, truncated, errors without messages). The logger's own keys always win. Never throws.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const write = opts.write ?? defaultWrite;

  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < ORDER[opts.level ?? defaults.level]) return;
    const redactor = opts.redactor ?? defaults.redactor;
    try {
      const line: Record<string, unknown> = { ts: new Date().toISOString(), level, service: opts.service, event };
      for (const [key, value] of Object.entries(sanitize(fields, redactor))) {
        if (!RESERVED.has(key)) line[key] = value;
      }
      write(JSON.stringify(line), level);
    } catch {
      // Logging must never take the process down (a closed pipe, an unexpected value); the event is dropped.
    }
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
