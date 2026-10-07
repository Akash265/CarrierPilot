import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { UpdateApplicationBodySchema, deleteApplication, getApplication, updateApplication } from "@ai-career/applications";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { toApplicationView, toEventView } from "../../../../lib/applications/serializeApplication";
import { applicationErrorResponse } from "../../../../lib/applications/errorResponse";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Application not found" }, { status: 404 });
type Ctx = { params: Promise<{ id: string }> };

async function handleGET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const found = await getApplication(db, env.DEFAULT_USER_ID, id);
    if (!found) return notFound();
    return NextResponse.json({ application: toApplicationView(found.application), events: found.events.map(toEventView) });
  } finally {
    await closeDbClient(db);
  }
}

async function handlePATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = UpdateApplicationBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await updateApplication(db, env.DEFAULT_USER_ID, id, parsed.data);
    return NextResponse.json({ application: toApplicationView(row) });
  } catch (error) {
    const mapped = applicationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

async function handleDELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    return (await deleteApplication(db, env.DEFAULT_USER_ID, id)) ? new NextResponse(null, { status: 204 }) : notFound();
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/applications/[id]", handleGET);
export const PATCH = withRouteErrors("/api/applications/[id]", handlePATCH);
export const DELETE = withRouteErrors("/api/applications/[id]", handleDELETE);
