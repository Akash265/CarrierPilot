import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AutomationError } from "../errors";
import { getAutofillSupport } from "./support";

const { jobs, candidateProfiles, automationSessions } = schema;

export type SessionRow = typeof automationSessions.$inferSelect;

/** Postgres unique_violation (23505), bare or wrapped as `cause` by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Design §6 POST. The partial unique index automation_sessions_one_active_per_user is the concurrency backstop
 * for "one browser window at a time" -> session_active.
 */
export async function createSession(db: DbClient, userId: string, jobId: string): Promise<SessionRow> {
  try {
    return await withUserContext(db, userId, async (tx) => {
      const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!job) throw new AutomationError("job_not_found");
      const [profile] = await tx.select({ id: candidateProfiles.id }).from(candidateProfiles).limit(1);
      if (!profile) throw new AutomationError("profile_missing");
      const support = await getAutofillSupport(tx, jobId);
      if (!support.supported) throw new AutomationError("unsupported", support.reason);
      const [row] = await tx
        .insert(automationSessions)
        .values({ jobId, portal: support.portal, adapterVersion: support.adapterVersion, formUrl: support.formUrl, status: "queued" })
        .returning();
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AutomationError("session_active");
    throw error;
  }
}
