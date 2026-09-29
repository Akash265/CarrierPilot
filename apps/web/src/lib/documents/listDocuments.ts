// apps/web/src/lib/documents/listDocuments.ts
import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toDocumentView, type DocumentView } from "./serializeDocument";

const { generatedDocuments, resumeOptimizations, applicationPitches } = schema;

/** Call inside withUserContext. Newest first, with the source optimization/pitch version number. */
export async function listDocuments(tx: DbClient, jobId: string): Promise<DocumentView[]> {
  const rows = await tx
    .select({ doc: generatedDocuments, optVersion: resumeOptimizations.version, pitchVersion: applicationPitches.version })
    .from(generatedDocuments)
    .leftJoin(resumeOptimizations, eq(resumeOptimizations.id, generatedDocuments.resumeOptimizationId))
    .leftJoin(applicationPitches, eq(applicationPitches.id, generatedDocuments.applicationPitchId))
    .where(eq(generatedDocuments.jobId, jobId))
    .orderBy(desc(generatedDocuments.createdAt));
  return rows.map(({ doc, optVersion, pitchVersion }) => toDocumentView(doc, optVersion ?? pitchVersion ?? null));
}
