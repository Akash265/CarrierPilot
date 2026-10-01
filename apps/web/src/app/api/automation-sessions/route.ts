import { NextResponse } from "next/server";
import { z } from "zod";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createSession, failSession, getJobAutofillOverview } from "@ai-career/browser";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { enqueueAutofill } from "../../../lib/browser-automation/enqueue";
import { toSessionView } from "../../../lib/browser-automation/serializeSession";
import { automationErrorResponse } from "../../../lib/browser-automation/errorResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CreateBodySchema = z.object({ jobId: z.string().uuid() }).strict();
const jobNotFound = () => NextResponse.json({ error: "Job not found" }, { status: 404 });

/** Everything AutofillPanel renders, in one request (design §6). */
export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (jobId === null) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  if (!UUID_RE.test(jobId)) return jobNotFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const overview = await getJobAutofillOverview(db, env.DEFAULT_USER_ID, jobId);
    if (!overview) return jobNotFound();
    return NextResponse.json({ ...overview, sessions: overview.sessions.map(toSessionView) });
  } finally {
    await closeDbClient(db);
  }
}

export async function POST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = CreateBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const session = await createSession(db, env.DEFAULT_USER_ID, parsed.data.jobId);
    try {
      await enqueueAutofill(env, { sessionId: session.id, userId: env.DEFAULT_USER_ID });
    } catch {
      await failSession(db, env.DEFAULT_USER_ID, session.id, "enqueue_failed");
      return NextResponse.json({ error: "The browser worker queue is unavailable. Is Redis running?" }, { status: 503 });
    }
    return NextResponse.json({ session: toSessionView(session) }, { status: 201 });
  } catch (error) {
    const mapped = automationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
