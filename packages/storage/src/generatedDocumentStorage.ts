import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Client } from "minio";

export const GENERATED_DOCUMENTS_BUCKET = "generated-documents";

async function ensureBucketExists(client: Client): Promise<void> {
  const exists = await client.bucketExists(GENERATED_DOCUMENTS_BUCKET).catch(() => false);
  if (!exists) await client.makeBucket(GENERATED_DOCUMENTS_BUCKET);
}

/** Keys are generated here and never contain user-supplied text (Phase 7b design §7). */
export async function uploadGeneratedDocument(
  client: Client,
  params: { userId: string; buffer: Buffer; extension: "pdf" | "docx" }
): Promise<{ objectKey: string }> {
  await ensureBucketExists(client);
  const objectKey = `${params.userId}/${randomUUID()}.${params.extension}`;
  await client.putObject(GENERATED_DOCUMENTS_BUCKET, objectKey, params.buffer, params.buffer.length);
  return { objectKey };
}

export async function getGeneratedDocument(client: Client, objectKey: string): Promise<Readable> {
  return client.getObject(GENERATED_DOCUMENTS_BUCKET, objectKey);
}

export async function deleteGeneratedDocument(client: Client, objectKey: string): Promise<void> {
  await client.removeObject(GENERATED_DOCUMENTS_BUCKET, objectKey);
}
