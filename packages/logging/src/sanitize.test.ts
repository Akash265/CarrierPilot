import { describe, it, expect } from "vitest";
import { sanitize, serializeError } from "./sanitize";
import { Redactor } from "./redactor";

const SENTINEL = "SENTINEL-MESSAGE-resume text: Built a pipeline at Acme";
const redactor = new Redactor();
redactor.setValues(["Jane Doe"]);

function errorWithStack(name: string, stack: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(SENTINEL);
  e.name = name;
  e.stack = stack;
  return Object.assign(e, extra);
}

describe("serializeError", () => {
  it("keeps the name and repo-relative frames, never the message", () => {
    const e = errorWithStack(
      "TypeError",
      [
        `TypeError: ${SENTINEL}`,
        "    at buildSnapshot (/Users/x/project/packages/resume-optimization/src/build.ts:12:5)",
        "    at async handler (file:///Users/x/project/apps/web/src/app/api/x/route.ts:30:9)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
        "    at Object.query (/Users/x/project/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/query.js:10:2)",
        "    at /app/services/matching-worker/src/main.ts:5:1",
        "    at chunk (/Users/x/project/apps/web/.next/server/chunks/123.js:1:4500)",
      ].join("\n")
    );
    const out = serializeError(e);
    expect(out).toEqual({
      name: "TypeError",
      frames: [
        "packages/resume-optimization/src/build.ts:12:5",
        "apps/web/src/app/api/x/route.ts:30:9",
        "services/matching-worker/src/main.ts:5:1",
        ".next/server/chunks/123.js:1:4500",
      ],
    });
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
  });

  it("keeps a code-like code (Postgres SQLSTATE, Node errno) and drops anything else", () => {
    expect(serializeError(errorWithStack("PostgresError", "PostgresError: x", { code: "23505" }))).toMatchObject({ code: "23505" });
    expect(serializeError(errorWithStack("Error", "Error: x", { code: "ECONNREFUSED" }))).toMatchObject({ code: "ECONNREFUSED" });
    expect(serializeError(errorWithStack("Error", "Error: x", { code: "Key (email)=(jane@example.com) exists" }))).not.toHaveProperty("code");
    expect(serializeError(errorWithStack("Error", "Error: x", { code: 42 }))).not.toHaveProperty("code");
  });

  it("caps frames at 8", () => {
    const stack = ["Error: x", ...Array.from({ length: 12 }, (_, i) => `    at f${i} (/r/packages/a/src/f.ts:${i + 1}:1)`)].join("\n");
    expect(serializeError(errorWithStack("Error", stack)).frames).toHaveLength(8);
  });

  it("reports a cause by name only", () => {
    const cause = errorWithStack("PostgresError", "PostgresError: secret");
    const e = errorWithStack("MatchingError", "MatchingError: unknown", { cause });
    const out = serializeError(e);
    expect(out).toMatchObject({ name: "MatchingError", causeName: "PostgresError" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("handles an error without a stack", () => {
    const e = new Error(SENTINEL);
    e.stack = undefined;
    expect(serializeError(e)).toEqual({ name: "Error", frames: [] });
  });
});

describe("sanitize", () => {
  it("scrubs strings and passes numbers, booleans and null through", () => {
    expect(sanitize({ who: "Jane Doe", mail: "x@y.io", n: 3, ok: true, none: null }, redactor)).toEqual({
      who: "[REDACTED]", mail: "[REDACTED_EMAIL]", n: 3, ok: true, none: null,
    });
  });

  it("drops undefined, functions and symbols; converts Date and bigint", () => {
    const out = sanitize({ u: undefined, f: () => 1, s: Symbol("x"), d: new Date("2026-10-07T00:00:00Z"), b: BigInt(12) }, redactor);
    expect(out).toEqual({ d: "2026-10-07T00:00:00.000Z", b: "12" });
  });

  it("truncates strings over 500 characters", () => {
    const out = sanitize({ s: "a".repeat(600) }, redactor) as { s: string };
    expect(out.s).toBe("a".repeat(500) + "…[truncated]");
  });

  it("serializes nested errors without their message", () => {
    const out = sanitize({ error: errorWithStack("TypeError", `TypeError: ${SENTINEL}`) }, redactor);
    expect(out).toEqual({ error: { name: "TypeError", frames: [] } });
  });

  it("stops at depth 3", () => {
    expect(sanitize({ a: { b: { c: { d: 1 } } } }, redactor)).toEqual({ a: { b: { c: "[depth]" } } });
  });

  it("caps arrays at 50 items", () => {
    const out = sanitize({ xs: Array.from({ length: 53 }, (_, i) => i) }, redactor) as { xs: unknown[] };
    expect(out.xs).toHaveLength(51);
    expect(out.xs[50]).toBe("[+3 more]");
  });

  it("replaces a cycle instead of recursing forever", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(sanitize({ a }, redactor)).toEqual({ a: { name: "a", self: "[circular]" } });
  });

  it("does not scrub keys", () => {
    expect(sanitize({ "Jane Doe": 1 }, redactor)).toEqual({ "Jane Doe": 1 });
  });
});
