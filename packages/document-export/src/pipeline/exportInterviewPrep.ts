import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { StoredInterviewPrepSections } from "@ai-career/application-package";
import type { DocumentFormat } from "../model/types";
import { buildInterviewPrepModel } from "../model/buildInterviewPrepModel";
import { buildDownloadFilename } from "../model/filename";
import { DocumentExportError } from "../errors";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobs, interviewPreparations, candidateProfiles } = schema;

export interface ExportInterviewPrepInput {
  userId: string;
  jobId: string;
  interviewPrepId: string;
  format: DocumentFormat;
}

/** Phase 7c design §6. Never refused for unsupported items (they are marked instead); the profile is read only for the filename. */
export async function exportInterviewPrep(db: DbClient, storage: Client, input: ExportInterviewPrepInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);

  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, title: jobs.title, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");

  const [prep] = await inUserContext((tx) =>
    tx
      .select()
      .from(interviewPreparations)
      .where(and(eq(interviewPreparations.id, input.interviewPrepId), eq(interviewPreparations.jobId, input.jobId)))
      .limit(1)
  );
  if (!prep) throw new DocumentExportError("source_mismatch");

  const [contact] = await inUserContext((tx) => tx.select({ fullName: candidateProfiles.fullName }).from(candidateProfiles).limit(1));
  if (!contact) throw new DocumentExportError("no_profile");

  return storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "interview_prep",
    format: input.format,
    model: buildInterviewPrepModel(job, prep.sections as StoredInterviewPrepSections, prep.gapTermsSnapshot as string[]),
    resumeOptimizationId: null,
    applicationPitchId: null,
    interviewPreparationId: prep.id,
    downloadFilename: buildDownloadFilename(contact.fullName, job.companyName, "interview_prep", input.format),
  });
}
