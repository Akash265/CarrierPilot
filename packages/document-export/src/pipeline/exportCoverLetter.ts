import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { StoredCoverLetterParagraph } from "@ai-career/application-package";
import type { DocumentFormat } from "../model/types";
import { buildCoverLetterModel } from "../model/buildCoverLetterModel";
import { buildDownloadFilename } from "../model/filename";
import { DocumentExportError } from "../errors";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobs, coverLetters, candidateProfiles } = schema;

export interface ExportCoverLetterInput {
  userId: string;
  jobId: string;
  coverLetterId: string;
  format: DocumentFormat;
}

/**
 * Same checks as exportPitch (Phase 7b design §4.4): a generated version with any supported === false
 * paragraph is refused -- an ungrounded claim must not reach an employer by accident; user_edited
 * versions (supported = null) always export.
 */
export async function exportCoverLetter(db: DbClient, storage: Client, input: ExportCoverLetterInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);

  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, title: jobs.title, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");

  const [letter] = await inUserContext((tx) =>
    tx.select().from(coverLetters).where(and(eq(coverLetters.id, input.coverLetterId), eq(coverLetters.jobId, input.jobId))).limit(1)
  );
  if (!letter) throw new DocumentExportError("source_mismatch");

  const paragraphs = letter.paragraphs as StoredCoverLetterParagraph[];
  if (letter.origin === "generated" && paragraphs.some((p) => p.supported === false)) {
    throw new DocumentExportError("cover_letter_unsupported");
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
    kind: "cover_letter",
    format: input.format,
    model: buildCoverLetterModel(contact, job, paragraphs),
    resumeOptimizationId: null,
    applicationPitchId: null,
    coverLetterId: letter.id,
    downloadFilename: buildDownloadFilename(contact.fullName, job.companyName, "cover_letter", input.format),
  });
}
