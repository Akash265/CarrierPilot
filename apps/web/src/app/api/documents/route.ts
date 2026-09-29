// apps/web/src/app/api/documents/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { exportPitch, exportResume, DocumentExportError } from "@ai-career/document-export";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { listDocuments } from "../../../lib/documents/listDocuments";
import { toDocumentView } from "../../../lib/documents/serializeDocument";
import { exportErrorResponse } from "../../../lib/documents/exportErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ExportBodySchema = z
  .object({
    kind: z.enum(["resume", "pitch"]),
    jobId: z.string().uuid(),
    sourceId: z.string().uuid(),
    format: z.enum(["pdf", "docx"]),
  })
  .strict();
const { resumeOptimizations, applicationPitches } = schema;

export async function POST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = ExportBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const { kind, jobId, sourceId, format } = parsed.data;

  const env = loadEnv();
  const db = createDbClient(env);
  const storage = createStorageClient(env);
  try {
    const row =
      kind === "resume"
        ? await exportResume(db, storage, { userId: env.DEFAULT_USER_ID, jobId, optimizationId: sourceId, format })
        : await exportPitch(db, storage, { userId: env.DEFAULT_USER_ID, jobId, pitchId: sourceId, format });
    const [source] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      kind === "resume"
        ? tx.select({ version: resumeOptimizations.version }).from(resumeOptimizations).where(eq(resumeOptimizations.id, sourceId)).limit(1)
        : tx.select({ version: applicationPitches.version }).from(applicationPitches).where(eq(applicationPitches.id, sourceId)).limit(1)
    );
    return NextResponse.json({ document: toDocumentView(row, source?.version ?? null) }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentExportError) return exportErrorResponse(error);
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId || !UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const documents = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listDocuments(tx, jobId));
    return NextResponse.json({ documents });
  } finally {
    await closeDbClient(db);
  }
}
