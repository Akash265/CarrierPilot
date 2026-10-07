import { describe, it, expect } from "vitest";
import { sanitize, serializeError } from "./sanitize";
import { Redactor } from "./redactor";

const SENTINEL = "SENTINEL-MESSAGE-resume text: Built a pipeline at Acme";
const redactor = new Redactor();
redactor.setValues(["Jane Doe"]);

/** An error whose stack has V8's shape: "<name>: <message>" (or just the name/message), then "    at <frame>" lines. */
function errorWithFrames(name: string, frames: string[] = [], extra: Record<string, unknown> = {}, message = SENTINEL): Error {
  const e = new Error(message);
  e.name = name;
  const header = name && message ? `${name}: ${message}` : name || message;
  e.stack = [header, ...frames.map((f) => `    at ${f}`)].join("\n");
  return Object.assign(e, extra);
}

describe("serializeError", () => {
  it("keeps the name and repo-relative frames, never the message", () => {
    const e = errorWithFrames("TypeError", [
      "buildSnapshot (/Users/x/project/packages/resume-optimization/src/build.ts:12:5)",
      "async handler (file:///Users/x/project/apps/web/src/app/api/x/route.ts:30:9)",
      "process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "Object.query (/Users/x/project/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/query.js:10:2)",
      "/app/services/matching-worker/src/main.ts:5:1",
      "chunk (/Users/x/project/apps/web/.next/server/chunks/123.js:1:4500)",
    ]);
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
    expect(serializeError(errorWithFrames("PostgresError", [], { code: "23505" }))).toMatchObject({ code: "23505" });
    expect(serializeError(errorWithFrames("Error", [], { code: "ECONNREFUSED" }))).toMatchObject({ code: "ECONNREFUSED" });
    expect(serializeError(errorWithFrames("Error", [], { code: "Key (email)=(jane@example.com) exists" }))).not.toHaveProperty("code");
    expect(serializeError(errorWithFrames("Error", [], { code: 42 }))).not.toHaveProperty("code");
  });

  it("caps frames at 8", () => {
    const frames = Array.from({ length: 12 }, (_, i) => `f${i} (/r/packages/a/src/f.ts:${i + 1}:1)`);
    expect(serializeError(errorWithFrames("Error", frames)).frames).toHaveLength(8);
  });

  it("reports a cause by name only", () => {
    const cause = errorWithFrames("PostgresError", [], {}, "secret");
    const out = serializeError(errorWithFrames("MatchingError", [], { cause }, "unknown"));
    expect(out).toMatchObject({ name: "MatchingError", causeName: "PostgresError" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("handles an error without a stack", () => {
    const e = new Error(SENTINEL);
    e.stack = undefined;
    expect(serializeError(e)).toEqual({ name: "Error", frames: [] });
  });

  it("reads frames from a real V8 stack", () => {
    const out = serializeError(new RangeError(SENTINEL));
    expect(out.name).toBe("RangeError");
    expect(out.frames[0]).toMatch(/^packages\/logging\/src\/sanitize\.test\.ts:\d+:\d+$/);
  });
});

describe("serializeError never emits message text", () => {
  it("skips every line of a multi-line message, even lines shaped like stack frames", () => {
    const message = "bad row\n    at Jane Doe, jane@example.com:2019\n    at Acme Corp Berlin:2021";
    const out = serializeError(errorWithFrames("Error", ["parse (/r/packages/ingestion/src/parse.ts:10:3)"], {}, message), redactor);
    expect(out.frames).toEqual(["packages/ingestion/src/parse.ts:10:3"]);
    expect(JSON.stringify(out)).not.toMatch(/Jane Doe|jane@example\.com|Acme Corp/);
  });

  it("skips a multi-line message in a real V8 stack", () => {
    const out = serializeError(new Error("bad row\n    at Jane Doe, jane@example.com:2019\n    at Acme Corp Berlin:2021"), redactor);
    expect(out.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toMatch(/Jane|jane@|Acme/);
  });

  it("fails closed -- no frames -- when the stack does not start with the error's own header", () => {
    const e = new Error("line one\n    at Secret Place:42");
    e.stack = ["CustomPrefix: line one", "    at Secret Place:42", "    at run (/r/services/x/src/main.ts:5:1)"].join("\n");
    expect(serializeError(e, redactor).frames).toEqual([]);
  });

  it("fails closed when the message changed after the stack was read (header no longer matches)", () => {
    const e = new Error("line\n    at Jane (/home/u/secret-file.ts:20:1)");
    void e.stack;
    e.message = "short";
    expect(serializeError(e, redactor).frames).toEqual([]);
    const prefix = new Error("short extra");
    void prefix.stack;
    prefix.message = "short";
    expect(serializeError(prefix, redactor).frames).toEqual([]);
  });

  it("reads frames after Node's coded header \"<name> [<code>]: <message>\", also with an empty message", () => {
    let real: Error | undefined;
    try {
      Buffer.alloc(-1);
    } catch (e) {
      real = e as Error;
    }
    expect(serializeError(real!).frames[0]).toMatch(/^packages\/logging\/src\/sanitize\.test\.ts:\d+:\d+$/);
    const empty = Object.assign(new Error(""), { name: "AggregateError", code: "ECONNREFUSED" });
    empty.stack = "AggregateError [ECONNREFUSED]: \n    at connect (/r/packages/db/src/client.ts:3:1)";
    expect(serializeError(empty).frames).toEqual(["packages/db/src/client.ts:3:1"]);
  });

  it("fails closed on a coded header whose code is not code-shaped or not the error's own", () => {
    const odd = Object.assign(new Error("m"), { code: "jane doe" });
    odd.stack = "Error [jane doe]: m\n    at run (/r/services/x/src/main.ts:5:1)";
    expect(serializeError(odd).frames).toEqual([]);
    const other = Object.assign(new Error("m"), { code: "E_ONE" });
    other.stack = "Error [E_TWO]: m\n    at run (/r/services/x/src/main.ts:5:1)";
    expect(serializeError(other).frames).toEqual([]);
  });

  it("does not read frames out of a name that contains newlines", () => {
    const e = errorWithFrames("Bad\n    at Jane (/home/u/secret-file.ts:20:1)", ["run (/r/services/x/src/main.ts:5:1)"], {}, "");
    const out = serializeError(e, redactor);
    expect(out.frames).toEqual(["services/x/src/main.ts:5:1"]);
    expect(out.name).toBe("Error");
  });

  it("only keeps identifier-shaped names; anything else (spaces, @, a profile value) becomes Error", () => {
    expect(serializeError(errorWithFrames("Jane Doe secret"), redactor).name).toBe("Error");
    expect(serializeError(errorWithFrames("Error", [], { cause: errorWithFrames("jane@example.com") }), redactor).causeName).toBe("Error");
    const single = new Redactor();
    single.setValues(["Janedoe"]);
    expect(serializeError(errorWithFrames("Janedoe"), single).name).toBe("Error");
    expect(serializeError(errorWithFrames("AggregateError")).name).toBe("AggregateError");
    expect(serializeError(errorWithFrames("Ingest.Error_2")).name).toBe("Ingest.Error_2");
  });

  it("scrubs a profile value that appears inside a real frame's path", () => {
    expect(serializeError(errorWithFrames("Error", ["f (/home/Jane Doe/project/packages/a/src/f.ts:1:2)"]), redactor).frames).toEqual([
      "packages/a/src/f.ts:1:2",
    ]);
    expect(serializeError(errorWithFrames("Error", ["f (/Jane Doe/f.ts:1:2)"]), redactor).frames).toEqual(["f.ts:1:2"]);
    expect(serializeError(errorWithFrames("Error", ["Jane Doe.method (Jane Doe:1:2)"]), redactor).frames).toEqual(["[REDACTED]:1:2"]);
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
    expect(sanitize({ error: errorWithFrames("TypeError") }, redactor)).toEqual({ error: { name: "TypeError", frames: [] } });
    expect(sanitize({ ctx: { cause: errorWithFrames("TypeError") } }, redactor)).toEqual({ ctx: { cause: { name: "TypeError", frames: [] } } });
  });

  it("logs a top-level `error` that is not an Error by its type only (a rejected string or object can carry content)", () => {
    expect(sanitize({ error: `resume text ${SENTINEL}` }, redactor)).toEqual({ error: { name: "NonError", type: "string" } });
    expect(sanitize({ error: { message: SENTINEL, body: "x" } }, redactor)).toEqual({ error: { name: "NonError", type: "object" } });
    expect(sanitize({ error: null }, redactor)).toEqual({ error: { name: "NonError", type: "null" } });
    expect(sanitize({ error: [SENTINEL] }, redactor)).toEqual({ error: { name: "NonError", type: "array" } });
    expect(sanitize({ error: undefined }, redactor)).toEqual({});
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
