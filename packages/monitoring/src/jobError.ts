import { failureCode } from "./workerState";

const DB_ERRORS = new Set(["DrizzleQueryError", "PostgresError"]);
/** Marks the errors this module makes, so originalJobError unwraps those and nothing else. */
const WRAPPED = Symbol("contentFreeJobError");
const RAW_CODE = /^[A-Za-z0-9_]{1,20}$/;

const codeOf = (e: { code?: unknown } | undefined) => (typeof e?.code === "string" && RAW_CODE.test(e.code) ? e.code.toLowerCase() : null);

/**
 * Phase 11c (D180). BullMQ stores a failed job's `message` and `stack` in Redis. Our own errors carry a code as their
 * message, but anything else may carry content -- a database error's message includes the query's parameters
 * (drizzle-orm ≥ 0.45 puts them there; Postgres itself quotes bad values). Such an error is replaced by one whose
 * message is a code (`database_error:<sqlstate>` or `job_failed:<code or class>`), with the original as `cause` for
 * the worker's message-free log line. UnrecoverableError keeps its name so BullMQ still does not retry it.
 */
export function contentFreeJobError(error: unknown): Error {
  if (error instanceof Error && failureCode(error.message) !== null) return error;
  const e = error instanceof Error ? (error as Error & { code?: unknown; cause?: unknown }) : undefined;
  const cause = e?.cause instanceof Error ? (e.cause as Error & { code?: unknown }) : undefined;
  const isDb = !!e && (DB_ERRORS.has(e.name) || (!!cause && DB_ERRORS.has(cause.name)));
  const detail = codeOf(e) ?? codeOf(cause) ?? (e ? e.name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40) || null : null);
  const out = new Error(`${isDb ? "database_error" : "job_failed"}${detail ? `:${detail}` : ""}`, { cause: error });
  if (e?.name === "UnrecoverableError") out.name = "UnrecoverableError";
  Object.defineProperty(out, WRAPPED, { value: true });
  return out;
}

/**
 * What a worker's `failed` handler should log (D180 review fix): the error the job actually threw, whose frames point
 * at the failure and whose cause carries the SQLSTATE -- the logger never writes messages, so this is safe. BullMQ
 * still stores only the content-free wrapper. Any error this module did not make is returned unchanged.
 */
export function originalJobError(error: unknown): unknown {
  return error instanceof Error && (error as Error & { [WRAPPED]?: boolean })[WRAPPED] ? error.cause : error;
}
