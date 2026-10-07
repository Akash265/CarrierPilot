// apps/web/src/app/api/documents/[id]/download/route.ts
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { createStorageClient, getGeneratedDocument, statGeneratedDocument } from "@ai-career/storage";
import { CONTENT_TYPES, contentDisposition } from "../../../../../lib/documents/serializeDocument";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_UNAVAILABLE_MESSAGE = "Document storage is unavailable. Try again.";
const { generatedDocuments } = schema;

/** The row is looked up under RLS first, so a known id of another user's document is a plain 404. */
async function handleGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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
      return NextResponse.json({ error: STORAGE_UNAVAILABLE_MESSAGE }, { status: 502 });
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
 * DocumentsList) before navigating the whole app to it, so an unknown/another user's document (404) or an
 * unreachable storage backend (502, same fixed message as GET) shows as an inline error instead of a raw
 * JSON error page. Confirms the object with a cheap `statGeneratedDocument` (no download) rather than
 * `getGeneratedDocument`'s full stream, since a preflight only needs to know reachability.
 */
async function handleHEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return new Response(null, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [doc] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select({ id: generatedDocuments.id, objectKey: generatedDocuments.objectKey }).from(generatedDocuments).where(eq(generatedDocuments.id, id)).limit(1)
    );
    if (!doc) return new Response(null, { status: 404 });

    try {
      await statGeneratedDocument(createStorageClient(env), doc.objectKey);
    } catch {
      // HEAD responses carry no body over the wire, but returning the same fixed message GET uses keeps
      // this handler's failure branch symmetric with GET's, and callers that inspect the Response object
      // directly (as the route tests do) can still assert on it.
      return NextResponse.json({ error: STORAGE_UNAVAILABLE_MESSAGE }, { status: 502 });
    }
    return new Response(null, { status: 200 });
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/documents/[id]/download", handleGET);
export const HEAD = withRouteErrors("/api/documents/[id]/download", handleHEAD);
