import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { deleteGeneratedDocument, uploadGeneratedDocument } from "@ai-career/storage";
import { RENDERER_VERSION, type DocumentFormat, type DocumentKind, type DocumentModel } from "../model/types";
import { modelContentHash } from "../model/hash";
import { assertSafeModel } from "../model/assertSafeModel";
import { renderDocument } from "../render/renderDocument";
import { DocumentExportError } from "../errors";

const { generatedDocuments } = schema;

export type GeneratedDocumentRow = typeof generatedDocuments.$inferSelect;

export interface StoreDocumentInput {
  userId: string;
  jobId: string;
  kind: DocumentKind;
  format: DocumentFormat;
  model: DocumentModel;
  resumeOptimizationId: string | null;
  applicationPitchId: string | null;
  downloadFilename: string;
}

/**
 * Hash → reuse, else render → upload (outside any transaction) → insert ON CONFLICT DO NOTHING.
 * A loser of a concurrent identical export deletes its own upload and returns the winner's row (D84).
 */
export async function storeDocument(db: DbClient, storage: Client, input: StoreDocumentInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);
  assertSafeModel(input.model);
  const contentHash = modelContentHash(input.model, input.format);
  const findExisting = () =>
    inUserContext((tx) =>
      tx
        .select()
        .from(generatedDocuments)
        .where(and(eq(generatedDocuments.kind, input.kind), eq(generatedDocuments.format, input.format), eq(generatedDocuments.contentHash, contentHash)))
        .limit(1)
    );

  const [existing] = await findExisting();
  if (existing) return existing;

  const buffer = await renderDocument(input.model, input.format);
  let objectKey: string;
  try {
    ({ objectKey } = await uploadGeneratedDocument(storage, { userId: input.userId, buffer, extension: input.format }));
  } catch {
    throw new DocumentExportError("storage_unavailable");
  }

  const [inserted] = await inUserContext((tx) =>
    tx
      .insert(generatedDocuments)
      .values({
        jobId: input.jobId,
        kind: input.kind,
        format: input.format,
        resumeOptimizationId: input.resumeOptimizationId,
        applicationPitchId: input.applicationPitchId,
        objectKey,
        byteSize: buffer.length,
        contentHash,
        rendererVersion: RENDERER_VERSION,
        downloadFilename: input.downloadFilename,
      })
      .onConflictDoNothing({ target: [generatedDocuments.userId, generatedDocuments.kind, generatedDocuments.format, generatedDocuments.contentHash] })
      .returning()
  );
  if (inserted) return inserted;

  await deleteGeneratedDocument(storage, objectKey).catch(() => {});
  const [winner] = await findExisting();
  if (!winner) throw new Error("generated_documents insert conflicted but no existing row was found");
  return winner;
}
