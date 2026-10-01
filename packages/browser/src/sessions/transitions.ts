import { and, eq, inArray } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AutomationError } from "../errors";
import { ACTIVE_STATUSES, isActiveStatus, isTerminalStatus, type AutomationStatus, type FieldAuditEntry } from "../types";
import type { SessionRow } from "./createSession";

const { automationSessions } = schema;

export interface TransitionPatch {
  fieldAudit?: FieldAuditEntry[];
  errorCode?: string | null;
  resumeDocumentId?: string | null;
  coverLetterDocumentId?: string | null;
  startedAt?: Date;
  submissionDetectedAt?: Date;
}

/**
 * A conditional UPDATE: only applies while the row is in one of `from`. Returns null when it was not (cancelled,
 * swept, or claimed elsewhere), which callers treat as "stop". ended_at follows the target status (CHECK).
 */
export async function transitionSession(
  db: DbClient,
  userId: string,
  sessionId: string,
  from: readonly AutomationStatus[],
  to: AutomationStatus,
  patch: TransitionPatch = {},
  now: Date = new Date()
): Promise<SessionRow | null> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx
      .update(automationSessions)
      .set({ ...patch, status: to, updatedAt: now, endedAt: isTerminalStatus(to) ? now : null })
      .where(and(eq(automationSessions.id, sessionId), inArray(automationSessions.status, [...from])))
      .returning();
    return row ?? null;
  });
}

export const failSession = (db: DbClient, userId: string, sessionId: string, errorCode: string) =>
  transitionSession(db, userId, sessionId, ACTIVE_STATUSES, "failed", { errorCode });

/**
 * Design §6 cancel. FOR UPDATE serializes with the worker's queued->launching claim: a queued row is abandoned
 * here directly; a row the worker already owns gets cancel_requested_at, which the worker polls.
 */
export async function requestCancel(db: DbClient, userId: string, sessionId: string, now: Date = new Date()): Promise<SessionRow> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx.select().from(automationSessions).where(eq(automationSessions.id, sessionId)).for("update");
    if (!row) throw new AutomationError("not_found");
    if (!isActiveStatus(row.status)) throw new AutomationError("not_cancellable");
    const patch =
      row.status === "queued"
        ? { status: "abandoned" as const, endedAt: now, errorCode: "cancelled", cancelRequestedAt: now, updatedAt: now }
        : { cancelRequestedAt: now, updatedAt: now };
    const [updated] = await tx.update(automationSessions).set(patch).where(eq(automationSessions.id, sessionId)).returning();
    return updated;
  });
}

export async function isCancelRequested(db: DbClient, userId: string, sessionId: string): Promise<boolean> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx
      .select({ at: automationSessions.cancelRequestedAt })
      .from(automationSessions)
      .where(eq(automationSessions.id, sessionId));
    return row?.at != null;
  });
}

/** Spec §11.5: run on worker startup. Queued sessions are left for the worker to pick up. */
export async function sweepInterruptedSessions(db: DbClient, userId: string, now: Date = new Date()): Promise<number> {
  return withUserContext(db, userId, async (tx) => {
    const rows = await tx
      .update(automationSessions)
      .set({ status: "failed", errorCode: "worker_restart", endedAt: now, updatedAt: now })
      .where(inArray(automationSessions.status, ["launching", "filling", "awaiting_user"]))
      .returning({ id: automationSessions.id });
    return rows.length;
  });
}
