import { Redactor } from "./redactor";

/**
 * Phase 11b design §3.2. Turns log fields into JSON-safe values that can never carry content: strings are scrubbed
 * and truncated, errors keep only their class name, a code-like `code` and repo-relative stack frames. An error's
 * message is never read -- it can echo resume, job or profile text that value scrubbing cannot recognise.
 */
const MAX_DEPTH = 3;
const MAX_ARRAY = 50;
const MAX_STRING = 500;
const MAX_FRAMES = 8;
const MAX_NAME = 100;
const MAX_FRAME = 200;
const CODE = /^[A-Za-z0-9_:.-]{1,40}$/;

export interface SerializedError {
  name: string;
  code?: string;
  causeName?: string;
  frames: string[];
}

function isErrorLike(v: unknown): v is Error {
  if (v instanceof Error) return true;
  return typeof v === "object" && v !== null && typeof (v as Error).name === "string" && typeof (v as Error).stack === "string";
}

/** `/abs/path/packages/x/src/f.ts:1:2` → `packages/x/src/f.ts:1:2`; Next's bundle paths keep `.next/...`. */
function relativeLocation(location: string): string {
  const path = location.replace(/^file:\/\//, "");
  const next = path.indexOf("/.next/");
  if (next >= 0) return path.slice(next + 1);
  const cut = Math.max(path.lastIndexOf("/apps/"), path.lastIndexOf("/packages/"), path.lastIndexOf("/services/"));
  if (cut >= 0) return path.slice(cut + 1);
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * V8 stacks start with "<Name>: <message>", and every line of a multi-line message comes before the first frame.
 * Those lines are skipped by count -- the message is measured, never emitted -- so a message line shaped like a
 * frame ("    at Jane Doe:2019") can never be mistaken for one (final-review fix, D173).
 */
function framesOf(stack: string | undefined, message: unknown, redactor: Redactor): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  const headerLines = Math.max(1, typeof message === "string" && message.length > 0 ? message.split("\n").length : 1);
  for (const line of stack.split("\n").slice(headerLines)) {
    const at = line.trim().match(/^at (.+)$/);
    if (!at) continue;
    const location = (at[1].match(/\(([^()]+)\)\s*$/)?.[1] ?? at[1]).trim();
    if (location.startsWith("node:") || location.includes("node_modules") || !/:\d+(:\d+)?$/.test(location)) continue;
    frames.push(cap(redactor.redact(relativeLocation(location)), MAX_FRAME));
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…[truncated]` : text);

/** Name, cause name and frames all go through the redactor: a name or a path can be built from content too. */
export function serializeError(error: Error, redactor: Redactor = new Redactor()): SerializedError {
  const name = typeof error.name === "string" && error.name ? error.name : "Error";
  const out: SerializedError = { name: cap(redactor.redact(name), MAX_NAME), frames: framesOf(error.stack, error.message, redactor) };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CODE.test(code)) out.code = code;
  const cause = (error as { cause?: unknown }).cause;
  if (isErrorLike(cause)) out.causeName = cap(redactor.redact(String(cause.name)), MAX_NAME);
  // Key order for readable lines: name, code, causeName, frames.
  return { name: out.name, ...(out.code ? { code: out.code } : {}), ...(out.causeName ? { causeName: out.causeName } : {}), frames: out.frames };
}

function sanitizeValue(value: unknown, redactor: Redactor, depth: number, ancestors: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string": {
      const scrubbed = redactor.redact(value);
      return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…[truncated]` : scrubbed;
    }
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (isErrorLike(value)) return serializeError(value, redactor);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const obj = value as object;
  if (ancestors.has(obj)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth]";
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, redactor, depth + 1, ancestors) ?? null);
      if (obj.length > MAX_ARRAY) items.push(`[+${obj.length - MAX_ARRAY} more]`);
      return items;
    }
    return sanitizeFields(obj as Record<string, unknown>, redactor, depth, ancestors);
  } finally {
    ancestors.delete(obj);
  }
}

function sanitizeFields(fields: Record<string, unknown>, redactor: Redactor, depth: number, ancestors: Set<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = sanitizeValue(raw, redactor, depth + 1, ancestors);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Sanitizes a fields object (the top level is depth 0; objects nested 3 levels below it become "[depth]"). */
export function sanitize(fields: Record<string, unknown>, redactor: Redactor): Record<string, unknown> {
  const ancestors = new Set<object>([fields]);
  return sanitizeFields(fields, redactor, 0, ancestors);
}
