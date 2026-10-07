import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { createDbClient, closeDbClient, withUserContext, schema } from "@ai-career/db";
import { createStorageClient, uploadResume, deleteResume } from "@ai-career/storage";
import {
  detectResumeFileType,
  extractText,
  extractProfileFromResume,
  createAnthropicFor,
  AiBudgetExceededError,
  UnsupportedFileTypeError,
  ExtractionValidationError,
  type MessagesClient,
  type ResumeExtractionDraft,
} from "@ai-career/ai";
import { createUsageSink } from "../../../../lib/aiUsage/createUsageSink";
import { budgetExceededResponse } from "../../../../lib/aiUsage/budgetResponse";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";
import { withRateLimit } from "../../../../lib/http/rateLimit";
import { CONTENT_LENGTH_SLACK_BYTES, MAX_UPLOAD_BYTES } from "../../../../lib/http/uploadLimits";

const MAX_FILE_SIZE_BYTES = MAX_UPLOAD_BYTES;

// Content-Length measures the whole multipart envelope (boundary markers,
// Content-Disposition/Content-Type headers, filename), not just the file
// bytes -- a file at exactly MAX_FILE_SIZE_BYTES still produces a slightly
// larger Content-Length. 64KB is far more than any realistic single-file
// form's overhead, so this stays a coarse, early rejection for uploads that
// are genuinely, unambiguously oversized; file.size below (checked against
// MAX_FILE_SIZE_BYTES with no slack) remains the real, authoritative limit. The slack is
// CONTENT_LENGTH_SLACK_BYTES in lib/http/uploadLimits.ts.

const MIME_BY_FILE_TYPE: Record<Awaited<ReturnType<typeof detectResumeFileType>>, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  tex: "text/x-tex",
};

async function extractWithRetry(
  anthropic: MessagesClient,
  env: Parameters<typeof extractProfileFromResume>[1],
  text: string
): Promise<ResumeExtractionDraft> {
  try {
    return await extractProfileFromResume(anthropic, env, text);
  } catch (error) {
    if (error instanceof ExtractionValidationError) {
      return await extractProfileFromResume(anthropic, env, text);
    }
    throw error;
  }
}

async function handlePOST(request: Request) {
  const env = loadEnv();

  // Reject an oversized upload from its declared Content-Length BEFORE
  // request.formData() buffers the entire multipart body into memory --
  // checking file.size afterward is too late to avoid that allocation.
  // This isn't a complete guarantee (a client could omit/lie about the
  // header, or use chunked transfer with no Content-Length at all), but it
  // stops the common case of an oversized upload without extra parsing
  // machinery, and file.size below remains the authoritative check.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_SIZE_BYTES + CONTENT_LENGTH_SLACK_BYTES) {
    return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });
  }

  // A non-multipart body makes formData() throw a TypeError; that is a bad request, not a server error.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Request must be multipart form data" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let fileType;
  try {
    fileType = await detectResumeFileType(buffer, file.name);
  } catch (error) {
    if (error instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const storageClient = createStorageClient(env);
  const db = createDbClient(env);

  try {
    const { objectKey } = await uploadResume(storageClient, {
      userId: env.DEFAULT_USER_ID,
      buffer,
      fileExtension: fileType,
    });

    const resumeDocumentId = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      await tx
        .update(schema.resumeDocuments)
        .set({ isActive: false })
        .where(eq(schema.resumeDocuments.isActive, true));

      const [row] = await tx
        .insert(schema.resumeDocuments)
        .values({
          objectKey,
          originalFilename: file.name,
          // The content-sniffed type (fileType), never the client-supplied
          // file.type -- storing the latter would defeat the point of
          // sniffing in the first place (spec §2: "detected via content
          // sniffing, not trusted from the client").
          mimeType: MIME_BY_FILE_TYPE[fileType],
          fileSizeBytes: file.size,
          extractionStatus: "pending",
          isActive: true,
        })
        .returning({ id: schema.resumeDocuments.id });
      return row.id as string;
    });

    try {
      // extractText() must stay INSIDE this try: a file that passes the magic-byte
      // sniff can still fail to parse (truncated/corrupt PDF, malformed DOCX zip),
      // and that is an expected, handled outcome -- the same one the spec defines
      // for a failed Anthropic/Zod extraction. Outside the try it would escape as
      // an unhandled 500 and leave extraction_status stuck at 'pending' forever.
      const text = await extractText(buffer, fileType);
      const anthropic = createAnthropicFor(env, createUsageSink(db, env))("resume_extraction");
      const draft = await extractWithRetry(anthropic, env, text);
      await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
        tx
          .update(schema.resumeDocuments)
          .set({ extractionStatus: "extracted" })
          .where(eq(schema.resumeDocuments.id, resumeDocumentId))
      );
      return NextResponse.json({ resumeDocumentId, status: "extracted", draft });
    } catch (error) {
      if (error instanceof AiBudgetExceededError) {
        await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
          tx
            .update(schema.resumeDocuments)
            .set({ extractionStatus: "failed", extractionError: "ai_budget_exceeded" })
            .where(eq(schema.resumeDocuments.id, resumeDocumentId))
        );
        return budgetExceededResponse(error, { resumeDocumentId, status: "failed" });
      }
      const message =
        error instanceof ExtractionValidationError ? error.message : "Extraction failed";
      await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
        tx
          .update(schema.resumeDocuments)
          .set({ extractionStatus: "failed", extractionError: message })
          .where(eq(schema.resumeDocuments.id, resumeDocumentId))
      );
      return NextResponse.json(
        { resumeDocumentId, status: "failed", error: message },
        { status: 200 }
      );
    }
  } finally {
    await closeDbClient(db);
  }
}

async function handleDELETE() {
  const env = loadEnv();
  const db = createDbClient(env);
  const storageClient = createStorageClient(env);

  try {
    const activeResume = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.resumeDocuments)
        .where(eq(schema.resumeDocuments.isActive, true));
      return row ?? null;
    });

    if (!activeResume) {
      return NextResponse.json({ error: "No active resume" }, { status: 404 });
    }

    await deleteResume(storageClient, activeResume.objectKey);
    await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.delete(schema.resumeDocuments).where(eq(schema.resumeDocuments.id, activeResume.id))
    );

    return NextResponse.json({ status: "deleted" });
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/profile/resume", withRateLimit("ai", "/api/profile/resume", handlePOST));
export const DELETE = withRouteErrors("/api/profile/resume", handleDELETE);
