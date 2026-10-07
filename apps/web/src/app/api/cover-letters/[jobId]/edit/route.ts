// apps/web/src/app/api/cover-letters/[jobId]/edit/route.ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createEditedCoverLetter, EditCoverLetterBodySchema, CoverLetterEditError } from "@ai-career/application-package";
import { readJsonBody } from "../../../../../lib/readJsonBody";
import { formatValidationError } from "../../../../../lib/formatValidationError";
import { toCoverLetterView } from "../../../../../lib/coverLetter/serializeCoverLetter";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handlePOST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = EditCoverLetterBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const coverLetter = await createEditedCoverLetter(db, env.DEFAULT_USER_ID, jobId, parsed.data);
    return NextResponse.json({ coverLetter: toCoverLetterView(coverLetter) }, { status: 201 });
  } catch (error) {
    if (error instanceof CoverLetterEditError) {
      const message =
        error.errorClass === "base_not_found"
          ? "The version you edited no longer exists for this job"
          : "The number of paragraphs does not match the version you edited";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/cover-letters/[jobId]/edit", handlePOST);
