import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toCoverLetterView, type CoverLetterView } from "./serializeCoverLetter";

const { coverLetters } = schema;

/** Call inside withUserContext. Newest version first. */
export async function listCoverLetters(tx: DbClient, jobId: string): Promise<CoverLetterView[]> {
  const rows = await tx.select().from(coverLetters).where(eq(coverLetters.jobId, jobId)).orderBy(desc(coverLetters.version));
  return rows.map(toCoverLetterView);
}
