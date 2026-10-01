import { eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import type { DocumentLinkIds } from "./documentLinks";

const { automationSessions, generatedDocuments } = schema;

const LINKABLE = new Set(["submission_detected", "abandoned"]);

export interface LinkableSession {
  id: string;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
}

/**
 * Phase 8 design §6. Call inside withUserContext. Locks the session so two "Record as applied" clicks cannot both
 * link it. Unknown (or another user's, hidden by RLS), other-job, still-active and already-linked sessions are all
 * `session_not_linkable`.
 */
export async function lockLinkableSession(tx: DbClient, sessionId: string, jobId: string): Promise<LinkableSession> {
  const [row] = await tx
    .select({
      id: automationSessions.id, jobId: automationSessions.jobId, status: automationSessions.status,
      applicationId: automationSessions.applicationId, resumeDocumentId: automationSessions.resumeDocumentId,
      coverLetterDocumentId: automationSessions.coverLetterDocumentId,
    })
    .from(automationSessions)
    .where(eq(automationSessions.id, sessionId))
    .for("update");
  if (!row || row.jobId !== jobId || !LINKABLE.has(row.status) || row.applicationId !== null) {
    throw new ApplicationError("session_not_linkable");
  }
  return { id: row.id, resumeDocumentId: row.resumeDocumentId, coverLetterDocumentId: row.coverLetterDocumentId };
}

/** Spec §11.8: ids the body leaves undefined default to the sources of the files the session actually attached. */
export async function withSessionDocuments(tx: DbClient, session: LinkableSession, body: DocumentLinkIds): Promise<DocumentLinkIds> {
  const sourceOf = async (documentId: string | null) => {
    if (!documentId) return null;
    const [doc] = await tx
      .select({ resumeOptimizationId: generatedDocuments.resumeOptimizationId, coverLetterId: generatedDocuments.coverLetterId })
      .from(generatedDocuments)
      .where(eq(generatedDocuments.id, documentId));
    return doc ?? null;
  };
  const resume = await sourceOf(session.resumeDocumentId);
  const letter = await sourceOf(session.coverLetterDocumentId);
  return {
    resumeOptimizationId: body.resumeOptimizationId !== undefined ? body.resumeOptimizationId : (resume?.resumeOptimizationId ?? null),
    applicationPitchId: body.applicationPitchId,
    coverLetterId: body.coverLetterId !== undefined ? body.coverLetterId : (letter?.coverLetterId ?? null),
  };
}
