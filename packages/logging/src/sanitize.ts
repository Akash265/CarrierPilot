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
 * V8 stacks start with a header -- "<name>: <message>", or just the name or the message when the other is empty --
 * followed by "    at ..." frame lines. That exact header text is skipped (the message is matched, never emitted), so a
 * message or name line shaped like a frame ("    at Jane Doe:2019") can never be read as one. Fail closed: if the
 * stack does not start with the error's own header followed by a line break (a custom stack, or a message changed
 * after the stack was captured), no frames are emitted at all (D173, D175). Node writes a coded error's header as
 * "<name> [<code>]: <message>" (even with an empty message); that form counts only with the error's own code-shaped
 * code.
 */
function framesOf(stack: string | undefined, name: unknown, message: unknown, code: unknown, redactor: Redactor): string[] {
  if (!stack) return [];
  const n = typeof name === "string" ? name : "";
  const m = typeof message === "string" ? message : "";
  const headers = [n && m ? `${n}: ${m}` : n || m];
  if (typeof code === "string" && CODE.test(code)) headers.push(`${n} [${code}]: ${m}`);
  const header = headers.find((h) => stack.startsWith(h) && (stack.length === h.length || stack[h.length] === "\n"));
  if (header === undefined) return [];
  const frames: string[] = [];
  for (const line of stack.slice(header.length).split("\n")) {
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

const IDENTIFIER = /^[A-Za-z_$][\w$.]{0,99}$/;

/**
 * An error or cause name is kept only if it is identifier-shaped and holds no D9 value (class names always are);
 * anything else -- spaces, newlines, an email, a profile value -- becomes "Error" (D175).
 */
function safeName(name: unknown, redactor: Redactor): string {
  return typeof name === "string" && IDENTIFIER.test(name) && redactor.redact(name) === name ? name : "Error";
}

/** Frames go through the redactor too: a path can contain a profile value. */
export function serializeError(error: Error, redactor: Redactor = new Redactor()): SerializedError {
  const code = (error as { code?: unknown }).code;
  const out: SerializedError = {
    name: safeName(error.name, redactor), frames: framesOf(error.stack, error.name, error.message, code, redactor),
  };
  if (typeof code === "string" && CODE.test(code)) out.code = code;
  const cause = (error as { cause?: unknown }).cause;
  if (isErrorLike(cause)) out.causeName = safeName(cause.name, redactor);
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
    // Convention: a top-level `error` field holds a thrown or rejected value. One that is not an Error (a rejected
    // string, a plain `{ message, body }` object) can carry content, so only its type is logged (D175).
    if (depth === 0 && key === "error" && raw !== undefined && !isErrorLike(raw)) {
      out[key] = { name: "NonError", type: raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw };
      continue;
    }
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
