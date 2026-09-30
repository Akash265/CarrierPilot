import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import { planStatusChange } from "./status";
import { loadLinkedDocuments } from "./documentLinks";
import type { ChangeStatusBody, UpdateApplicationBody, UserEventBody } from "./bodies";
import type { ApplicationEventRow, ApplicationRow } from "./types";

const { applications, applicationEvents } = schema;

/** Locks the row for the rest of the transaction so concurrent changes serialize. */
async function lockApplication(tx: DbClient, id: string): Promise<ApplicationRow> {
  const [row] = await tx.select().from(applications).where(eq(applications.id, id)).for("update");
  if (!row) throw new ApplicationError("not_found");
  return row;
}

export async function changeStatus(
  db: DbClient,
  userId: string,
  id: string,
  body: ChangeStatusBody,
  now: Date = new Date()
): Promise<ApplicationRow> {
  return withUserContext(db, userId, async (tx) => {
    const current = await lockApplication(tx, id);
    const plan = planStatusChange({
      current: current.status,
      currentTerminalAt: current.terminalAt,
      to: body.toStatus,
      now,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
    });
    const [row] = await tx
      .update(applications)
      .set({ status: plan.status, statusChangedAt: plan.statusChangedAt, terminalAt: plan.terminalAt, updatedAt: now })
      .where(eq(applications.id, id))
      .returning();
    await tx.insert(applicationEvents).values({
      applicationId: id, type: "status_change", occurredAt: plan.statusChangedAt, fromStatus: current.status, toStatus: plan.status, detail: {},
    });
    if (body.note) {
      await tx.insert(applicationEvents).values({ applicationId: id, type: "note", occurredAt: plan.statusChangedAt, detail: { text: body.note } });
    }
    return row;
  });
}

export async function addEvent(
  db: DbClient,
  userId: string,
  id: string,
  body: UserEventBody,
  now: Date = new Date()
): Promise<ApplicationEventRow> {
  return withUserContext(db, userId, async (tx) => {
    await lockApplication(tx, id);
    if (body.type === "follow_up_done") {
      await tx.update(applications).set({ followUpAt: null, updatedAt: now }).where(eq(applications.id, id));
    } else if (body.type === "follow_up_snoozed") {
      await tx.update(applications).set({ followUpAt: body.detail.newFollowUpAt, updatedAt: now }).where(eq(applications.id, id));
    }
    const [event] = await tx
      .insert(applicationEvents)
      .values({ applicationId: id, type: body.type, occurredAt: body.occurredAt ? new Date(body.occurredAt) : now, detail: body.detail })
      .returning();
    return event;
  });
}

/** Edits user-owned fields only. feature_snapshot is never touched (design §3), even when links change. */
export async function updateApplication(
  db: DbClient,
  userId: string,
  id: string,
  body: UpdateApplicationBody,
  now: Date = new Date()
): Promise<ApplicationRow> {
  return withUserContext(db, userId, async (tx) => {
    const current = await lockApplication(tx, id);
    const linksChanged = [body.resumeOptimizationId, body.applicationPitchId, body.coverLetterId].some((v) => v !== undefined && v !== null);
    if (linksChanged) {
      if (current.jobId === null) throw new ApplicationError("document_mismatch");
      await loadLinkedDocuments(tx, current.jobId, body);
    }
    const patch = Object.fromEntries(
      Object.entries(body).map(([k, v]) => [k, typeof v === "string" && v === "" ? null : v]).filter(([, v]) => v !== undefined)
    ) as Partial<ApplicationRow>;
    const [row] = await tx.update(applications).set({ ...patch, updatedAt: now }).where(eq(applications.id, id)).returning();
    return row;
  });
}

export async function deleteApplication(db: DbClient, userId: string, id: string): Promise<boolean> {
  return withUserContext(db, userId, async (tx) => {
    const rows = await tx.delete(applications).where(eq(applications.id, id)).returning({ id: applications.id });
    return rows.length > 0;
  });
}
