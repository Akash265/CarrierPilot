import { describe, it, expect } from "vitest";
import { contentFreeJobError } from "./jobError";
import { failureCode } from "./workerState";

const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(Object.assign(new Error(message), { name }), extra);

describe("contentFreeJobError", () => {
  it("keeps an error whose message is already one of our codes, unchanged", () => {
    const unrecoverable = named("UnrecoverableError", "no_active_goal");
    expect(contentFreeJobError(unrecoverable)).toBe(unrecoverable);
    const ingest = named("IngestError", "fetch_failed:http_503");
    expect(contentFreeJobError(ingest)).toBe(ingest);
  });

  it("replaces a database error's message (which carries the query's parameters) with a code", () => {
    const pg = named("PostgresError", 'invalid input syntax for type uuid: "Jane Doe"', { code: "22P02" });
    const wrapped = named("DrizzleQueryError", "Failed query: select 1\nparams: Jane Doe, jane@example.com", { cause: pg });
    const out = contentFreeJobError(wrapped);
    expect(out.message).toBe("database_error:22p02");
    expect(out.stack).not.toMatch(/Jane|jane@/);
    expect(out.cause).toBe(wrapped);
    expect(failureCode(out.message)).toBe("database_error:22p02");
    expect(contentFreeJobError(pg).message).toBe("database_error:22p02");
  });

  it("reduces any other error to job_failed plus its code-shaped code or class name", () => {
    expect(contentFreeJobError(named("TypeError", "Cannot read properties of undefined (reading 'Jane')")).message).toBe("job_failed:typeerror");
    expect(contentFreeJobError(named("Error", "connect ECONNREFUSED 10.0.0.1:5432", { code: "ECONNREFUSED" })).message).toBe("job_failed:econnrefused");
    expect(contentFreeJobError("a rejected string with Jane Doe").message).toBe("job_failed");
    expect(contentFreeJobError(named("Weird Name!", "x y")).message).toBe("job_failed:weirdname");
  });

  it("keeps UnrecoverableError's name so BullMQ still does not retry it", () => {
    const out = contentFreeJobError(named("UnrecoverableError", "unknown maintenance job: Jane"));
    expect(out.name).toBe("UnrecoverableError");
    expect(out.message).toBe("job_failed:unrecoverableerror");
    expect(failureCode(out.message)).not.toBeNull();
  });
});
