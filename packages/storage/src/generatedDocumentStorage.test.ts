import { describe, it, expect, afterAll } from "vitest";
import type { Readable } from "node:stream";
import { createStorageClient } from "./client";
import {
  uploadGeneratedDocument, getGeneratedDocument, deleteGeneratedDocument, statGeneratedDocument, listGeneratedDocuments, GENERATED_DOCUMENTS_BUCKET,
} from "./generatedDocumentStorage";

const client = createStorageClient({
  MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
  MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
  MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
});
const created: string[] = [];

afterAll(async () => {
  for (const key of created) await deleteGeneratedDocument(client, key).catch(() => {});
});

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("generated document storage", () => {
  it("uploads under {userId}/{uuid}.{ext}, reads back the same bytes, then deletes", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const buffer = Buffer.from("%PDF-1.7 generated");
    const { objectKey } = await uploadGeneratedDocument(client, { userId, buffer, extension: "pdf" });
    created.push(objectKey);

    expect(objectKey).toMatch(new RegExp(`^${userId}/[0-9a-f-]{36}\\.pdf$`));
    expect((await readAll(await getGeneratedDocument(client, objectKey))).equals(buffer)).toBe(true);

    await deleteGeneratedDocument(client, objectKey);
    await expect(client.statObject(GENERATED_DOCUMENTS_BUCKET, objectKey)).rejects.toThrow();
  });

  it("uses a distinct key for every upload", async () => {
    const params = { userId: "00000000-0000-0000-0000-000000000001", buffer: Buffer.from("x"), extension: "docx" as const };
    const a = await uploadGeneratedDocument(client, params);
    const b = await uploadGeneratedDocument(client, params);
    created.push(a.objectKey, b.objectKey);
    expect(a.objectKey).not.toBe(b.objectKey);
    expect(a.objectKey.endsWith(".docx")).toBe(true);
  });

  describe("statGeneratedDocument", () => {
    it("resolves for an object that exists and rejects for one that does not", async () => {
      const userId = "00000000-0000-0000-0000-000000000001";
      const { objectKey } = await uploadGeneratedDocument(client, { userId, buffer: Buffer.from("x"), extension: "pdf" });
      created.push(objectKey);

      await expect(statGeneratedDocument(client, objectKey)).resolves.toBeUndefined();
      await expect(statGeneratedDocument(client, `${userId}/does-not-exist.pdf`)).rejects.toThrow();
    });
  });

  it("lists objects under a prefix with their last-modified time", async () => {
    const userId = "00000000-0000-0000-0000-0000000009a9";
    const { objectKey } = await uploadGeneratedDocument(client, { userId, buffer: Buffer.from("x"), extension: "pdf" });
    created.push(objectKey);
    const listed = await listGeneratedDocuments(client, `${userId}/`);
    const mine = listed.find((o) => o.key === objectKey);
    expect(mine?.lastModified).toBeInstanceOf(Date);
    expect(listed.every((o) => o.key.startsWith(`${userId}/`))).toBe(true);
  });
});
