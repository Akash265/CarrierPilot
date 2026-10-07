import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { getApplicationForJob, listDocumentOptions } from "@ai-career/applications";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleGET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const application = await getApplicationForJob(db, env.DEFAULT_USER_ID, jobId);
    const documentOptions = await listDocumentOptions(db, env.DEFAULT_USER_ID, jobId);
    return NextResponse.json({
      application: application && { id: application.id, status: application.status, appliedAt: application.appliedAt },
      documentOptions,
    });
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/applications/for-job/[jobId]", handleGET);
