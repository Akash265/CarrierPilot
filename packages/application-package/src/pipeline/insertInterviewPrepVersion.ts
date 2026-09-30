import { eq, max, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";

const { interviewPreparations } = schema;

export type InterviewPrepRow = typeof interviewPreparations.$inferSelect;
export type NewInterviewPrepVersion = Omit<typeof interviewPreparations.$inferInsert, "id" | "userId" | "jobId" | "version" | "createdAt">;

/**
 * Allocates the next version for (user, job) and inserts it. MUST run inside withUserContext: the
 * transaction-scoped advisory lock serializes concurrent generate calls so they get N+1 and N+2
 * instead of a unique-index violation. Same pattern as insertPitchVersion, own lock namespace.
 */
export async function insertInterviewPrepVersion(tx: DbClient, userId: string, jobId: string, values: NewInterviewPrepVersion): Promise<InterviewPrepRow> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('interview_preparations'), hashtext(${userId} || ':' || ${jobId}))`);
  const [{ maxVersion }] = await tx
    .select({ maxVersion: max(interviewPreparations.version) })
    .from(interviewPreparations)
    .where(eq(interviewPreparations.jobId, jobId));
  const [row] = await tx.insert(interviewPreparations).values({ ...values, jobId, version: (maxVersion ?? 0) + 1 }).returning();
  return row;
}
