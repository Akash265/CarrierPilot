import { eq, max, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";

const { coverLetters } = schema;

export type CoverLetterRow = typeof coverLetters.$inferSelect;
export type NewCoverLetterVersion = Omit<typeof coverLetters.$inferInsert, "id" | "userId" | "jobId" | "version" | "createdAt">;

/**
 * Allocates the next version for (user, job) and inserts it. MUST run inside withUserContext: the
 * transaction-scoped advisory lock serializes concurrent generate/edit calls so they get N+1 and N+2
 * instead of a unique-index violation. Same pattern as insertPitchVersion, own lock namespace.
 */
export async function insertCoverLetterVersion(tx: DbClient, userId: string, jobId: string, values: NewCoverLetterVersion): Promise<CoverLetterRow> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cover_letters'), hashtext(${userId} || ':' || ${jobId}))`);
  const [{ maxVersion }] = await tx.select({ maxVersion: max(coverLetters.version) }).from(coverLetters).where(eq(coverLetters.jobId, jobId));
  const [row] = await tx.insert(coverLetters).values({ ...values, jobId, version: (maxVersion ?? 0) + 1 }).returning();
  return row;
}
