import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { buildResumeSnapshot, type AppliedBullet } from "@ai-career/resume-optimization";
import type { DocumentFormat } from "../model/types";
import { buildResumeModel } from "../model/buildResumeModel";
import { buildDownloadFilename } from "../model/filename";
import { DocumentExportError } from "../errors";
import { loadResumeProfile } from "./loadResumeProfile";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobs, resumeOptimizations } = schema;

export interface ExportResumeInput {
  userId: string;
  jobId: string;
  optimizationId: string;
  format: DocumentFormat;
}

/** Phase 7b design §4.4. Refuses (profile_changed) when the profile no longer matches the optimization (D84). */
export async function exportResume(db: DbClient, storage: Client, input: ExportResumeInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);

  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");

  const [optimization] = await inUserContext((tx) =>
    tx
      .select()
      .from(resumeOptimizations)
      .where(and(eq(resumeOptimizations.id, input.optimizationId), eq(resumeOptimizations.jobId, input.jobId)))
      .limit(1)
  );
  if (!optimization) throw new DocumentExportError("source_mismatch");

  const { snapshot, profile } = await inUserContext(async (tx) => ({
    snapshot: await buildResumeSnapshot(tx),
    profile: await loadResumeProfile(tx),
  }));
  if (snapshot.contentHash !== optimization.sourceProfileContentHash) throw new DocumentExportError("profile_changed");
  if (!profile) throw new DocumentExportError("no_profile");

  const model = buildResumeModel(profile, optimization.selectedBullets as AppliedBullet[]);
  return storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "resume",
    format: input.format,
    model,
    resumeOptimizationId: optimization.id,
    applicationPitchId: null,
    downloadFilename: buildDownloadFilename(profile.contact.fullName, job.companyName, "resume", input.format),
  });
}
