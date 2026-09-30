import { and, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import type { SnapshotAtsInput, SnapshotDocumentRef } from "./snapshot";

const { resumeOptimizations, atsEvaluations, applicationPitches, coverLetters } = schema;

export interface DocumentLinkIds {
  resumeOptimizationId?: string | null;
  applicationPitchId?: string | null;
  coverLetterId?: string | null;
}

export interface LinkedDocuments {
  resume: SnapshotDocumentRef | null;
  pitch: SnapshotDocumentRef | null;
  coverLetter: SnapshotDocumentRef | null;
  /** The linked resume's ATS evaluation, if both exist. */
  ats: SnapshotAtsInput | null;
}

/**
 * Call inside withUserContext. Loads each non-null linked document, requiring it to belong to `jobId`
 * (design §3: enforced here because a CHECK cannot reference other tables). Any miss -- wrong job,
 * another user's row (hidden by RLS), or a deleted row -- is `document_mismatch`.
 */
export async function loadLinkedDocuments(tx: DbClient, jobId: string, ids: DocumentLinkIds): Promise<LinkedDocuments> {
  const result: LinkedDocuments = { resume: null, pitch: null, coverLetter: null, ats: null };

  if (ids.resumeOptimizationId) {
    const [row] = await tx
      .select({
        id: resumeOptimizations.id,
        version: resumeOptimizations.version,
        hash: resumeOptimizations.sourceProfileContentHash,
        atsOverall: atsEvaluations.overallScore,
        atsRequired: atsEvaluations.requiredKeywordCoverage,
        atsPreferred: atsEvaluations.preferredKeywordCoverage,
        atsSemantic: atsEvaluations.semanticSimilarity,
      })
      .from(resumeOptimizations)
      .leftJoin(atsEvaluations, eq(atsEvaluations.resumeOptimizationId, resumeOptimizations.id))
      .where(and(eq(resumeOptimizations.id, ids.resumeOptimizationId), eq(resumeOptimizations.jobId, jobId)))
      .limit(1);
    if (!row) throw new ApplicationError("document_mismatch");
    result.resume = { id: row.id, version: row.version, origin: null, sourceProfileContentHash: row.hash };
    if (row.atsOverall !== null && row.atsRequired !== null && row.atsPreferred !== null) {
      result.ats = {
        overallScore: row.atsOverall, requiredKeywordCoverage: row.atsRequired,
        preferredKeywordCoverage: row.atsPreferred, semanticSimilarity: row.atsSemantic,
      };
    }
  }

  if (ids.applicationPitchId) {
    const [row] = await tx
      .select({ id: applicationPitches.id, version: applicationPitches.version, origin: applicationPitches.origin, hash: applicationPitches.sourceProfileContentHash })
      .from(applicationPitches)
      .where(and(eq(applicationPitches.id, ids.applicationPitchId), eq(applicationPitches.jobId, jobId)))
      .limit(1);
    if (!row) throw new ApplicationError("document_mismatch");
    result.pitch = { id: row.id, version: row.version, origin: row.origin, sourceProfileContentHash: row.hash };
  }

  if (ids.coverLetterId) {
    const [row] = await tx
      .select({ id: coverLetters.id, version: coverLetters.version, origin: coverLetters.origin, hash: coverLetters.sourceProfileContentHash })
      .from(coverLetters)
      .where(and(eq(coverLetters.id, ids.coverLetterId), eq(coverLetters.jobId, jobId)))
      .limit(1);
    if (!row) throw new ApplicationError("document_mismatch");
    result.coverLetter = { id: row.id, version: row.version, origin: row.origin, sourceProfileContentHash: row.hash };
  }

  return result;
}
