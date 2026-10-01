import type { Client } from "minio";
import { deleteGeneratedDocument, listGeneratedDocuments } from "@ai-career/storage";
import type { RetentionStorage } from "@ai-career/applications";

/** S3 DeleteObject is idempotent, so removing an already-missing key succeeds. */
export function createRetentionStorage(client: Client): RetentionStorage {
  return {
    listObjects: (prefix) => listGeneratedDocuments(client, prefix),
    removeObject: (key) => deleteGeneratedDocument(client, key),
  };
}
