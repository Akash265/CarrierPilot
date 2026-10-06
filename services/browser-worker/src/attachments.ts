import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "minio";
import { getGeneratedDocument } from "@ai-career/storage";
import type { StoredDocumentRef } from "@ai-career/browser";
import type { AttachmentPaths } from "./actions";

export type FetchDocument = (objectKey: string) => Promise<Buffer>;

export function minioFetcher(client: Client): FetchDocument {
  return async (objectKey) => {
    const stream = await getGeneratedDocument(client, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
}

/** Fixed file names: the stored key and the user's download name never reach the page. A failure is reported, not thrown. */
export async function downloadAttachments(
  fetchDocument: FetchDocument,
  docs: { resume: StoredDocumentRef | null; coverLetter: StoredDocumentRef | null },
  dir: string
): Promise<{ paths: AttachmentPaths; failed: ("resume" | "cover_letter")[] }> {
  await mkdir(dir, { recursive: true });
  const paths: AttachmentPaths = {};
  const failed: ("resume" | "cover_letter")[] = [];
  for (const [kind, doc] of [["resume", docs.resume], ["cover_letter", docs.coverLetter]] as const) {
    if (!doc) continue;
    try {
      const file = path.join(dir, `${kind}.pdf`);
      await writeFile(file, await fetchDocument(doc.objectKey));
      paths[kind] = file;
    } catch {
      failed.push(kind);
    }
  }
  return { paths, failed };
}
