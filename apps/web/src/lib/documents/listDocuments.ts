// apps/web/src/lib/documents/listDocuments.ts
import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toDocumentView, type DocumentView } from "./serializeDocument";

const { generatedDocuments, resumeOptimizations, applicationPitches, coverLetters, interviewPreparations } = schema;

/** Call inside withUserContext. Newest first, with the source version number of whichever source the row has. */
export async function listDocuments(tx: DbClient, jobId: string): Promise<DocumentView[]> {
  const rows = await tx
    .select({
      doc: generatedDocuments,
      optVersion: resumeOptimizations.version,
      pitchVersion: applicationPitches.version,
      letterVersion: coverLetters.version,
      prepVersion: interviewPreparations.version,
    })
    .from(generatedDocuments)
    .leftJoin(resumeOptimizations, eq(resumeOptimizations.id, generatedDocuments.resumeOptimizationId))
    .leftJoin(applicationPitches, eq(applicationPitches.id, generatedDocuments.applicationPitchId))
    .leftJoin(coverLetters, eq(coverLetters.id, generatedDocuments.coverLetterId))
    .leftJoin(interviewPreparations, eq(interviewPreparations.id, generatedDocuments.interviewPreparationId))
    .where(eq(generatedDocuments.jobId, jobId))
    .orderBy(desc(generatedDocuments.createdAt));
  return rows.map(({ doc, optVersion, pitchVersion, letterVersion, prepVersion }) =>
    toDocumentView(doc, optVersion ?? pitchVersion ?? letterVersion ?? prepVersion ?? null)
  );
}
