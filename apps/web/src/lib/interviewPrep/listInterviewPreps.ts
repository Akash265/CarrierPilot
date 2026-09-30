import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toInterviewPrepView, type InterviewPrepView } from "./serializeInterviewPrep";

const { interviewPreparations } = schema;

/** Call inside withUserContext. Newest version first. */
export async function listInterviewPreps(tx: DbClient, jobId: string): Promise<InterviewPrepView[]> {
  const rows = await tx.select().from(interviewPreparations).where(eq(interviewPreparations.jobId, jobId)).orderBy(desc(interviewPreparations.version));
  return rows.map(toInterviewPrepView);
}
