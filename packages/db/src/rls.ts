import { sql } from "drizzle-orm";
import type { DbClient } from "./client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WithUserContextOptions {
  /** Postgres transaction isolation level. Defaults to Postgres's own default (read committed) when omitted. */
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
}

/**
 * Every query touching a user-scoped table must go through this helper.
 * It sets the RLS session variable inside a transaction so it can never
 * leak across concurrent requests on a pooled connection.
 *
 * Default isolation is Postgres's "read committed": each statement in the transaction sees
 * whatever has committed so far, so two SELECTs several statements apart can observe different
 * data if another transaction commits in between. Callers that read more than once and need a
 * single consistent view (e.g. document-export's snapshot-hash-then-render) should pass
 * `{ isolationLevel: "repeatable read" }`.
 */
export async function withUserContext<T>(
  db: DbClient,
  userId: string,
  fn: (tx: DbClient) => Promise<T>,
  opts?: WithUserContextOptions
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new Error(`withUserContext: user id must be a UUID, got "${userId}"`);
  }
  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_user_id', ${userId}, true)`
      );
      return fn(tx as unknown as DbClient);
    },
    opts?.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined
  );
}
