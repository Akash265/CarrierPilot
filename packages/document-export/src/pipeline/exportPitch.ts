import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { StoredPitchBullet } from "@ai-career/application-package";
import type { DocumentFormat } from "../model/types";
import { buildPitchModel } from "../model/buildPitchModel";
import { buildDownloadFilename } from "../model/filename";
import { DocumentExportError } from "../errors";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobs, applicationPitches, candidateProfiles } = schema;

export interface ExportPitchInput {
  userId: string;
  jobId: string;
  pitchId: string;
  format: DocumentFormat;
}

/**
 * Phase 7b design §4.4. A generated version with any supported === false bullet is refused (D84): a claim the guard
 * could not ground must not reach an employer by accident. user_edited versions (supported = null) always export.
 */
export async function exportPitch(db: DbClient, storage: Client, input: ExportPitchInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);

  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, title: jobs.title, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");

  const [pitch] = await inUserContext((tx) =>
    tx
      .select()
      .from(applicationPitches)
      .where(and(eq(applicationPitches.id, input.pitchId), eq(applicationPitches.jobId, input.jobId)))
      .limit(1)
  );
  if (!pitch) throw new DocumentExportError("source_mismatch");

  const bullets = pitch.bullets as StoredPitchBullet[];
  if (pitch.origin === "generated" && bullets.some((b) => b.supported === false)) {
    throw new DocumentExportError("pitch_unsupported");
  }

  const [contact] = await inUserContext((tx) =>
    tx
      .select({ fullName: candidateProfiles.fullName, email: candidateProfiles.email, phoneNumber: candidateProfiles.phoneNumber, linkedinUrl: candidateProfiles.linkedinUrl })
      .from(candidateProfiles)
      .limit(1)
  );
  if (!contact) throw new DocumentExportError("no_profile");

  return storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "pitch",
    format: input.format,
    model: buildPitchModel(contact, job, bullets),
    resumeOptimizationId: null,
    applicationPitchId: pitch.id,
    downloadFilename: buildDownloadFilename(contact.fullName, job.companyName, "pitch", input.format),
  });
}
