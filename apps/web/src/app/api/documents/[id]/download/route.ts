// apps/web/src/app/api/documents/[id]/download/route.ts
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { createStorageClient, getGeneratedDocument } from "@ai-career/storage";
import { CONTENT_TYPES, contentDisposition } from "../../../../../lib/documents/serializeDocument";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { generatedDocuments } = schema;

/** The row is looked up under RLS first, so a known id of another user's document is a plain 404. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [doc] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select().from(generatedDocuments).where(eq(generatedDocuments.id, id)).limit(1)
    );
    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

    let stream: Readable;
    try {
      stream = await getGeneratedDocument(createStorageClient(env), doc.objectKey);
    } catch {
      return NextResponse.json({ error: "Document storage is unavailable. Try again." }, { status: 502 });
    }
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[doc.format],
        "Content-Length": String(doc.byteSize),
        "Content-Disposition": contentDisposition(doc.downloadFilename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } finally {
    await closeDbClient(db);
  }
}

/**
 * Same RLS-scoped lookup as GET, no body: lets a download link be preflighted (DownloadButtons,
 * DocumentsList) before navigating the whole app to it, so an unknown or another user's document shows as
 * an inline error instead of a raw JSON 404 page. Does not touch storage, so it does not surface a
 * storage_unavailable 502 -- only whether the row itself is visible to this user.
 */
export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return new Response(null, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [doc] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select({ id: generatedDocuments.id }).from(generatedDocuments).where(eq(generatedDocuments.id, id)).limit(1)
    );
    return new Response(null, { status: doc ? 200 : 404 });
  } finally {
    await closeDbClient(db);
  }
}
