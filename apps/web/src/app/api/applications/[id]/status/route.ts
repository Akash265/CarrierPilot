import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { ChangeStatusBodySchema, changeStatus } from "@ai-career/applications";
import { readJsonBody } from "../../../../../lib/readJsonBody";
import { formatValidationError } from "../../../../../lib/formatValidationError";
import { toApplicationView } from "../../../../../lib/applications/serializeApplication";
import { applicationErrorResponse } from "../../../../../lib/applications/errorResponse";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handlePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Application not found" }, { status: 404 });
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = ChangeStatusBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await changeStatus(db, env.DEFAULT_USER_ID, id, parsed.data);
    return NextResponse.json({ application: toApplicationView(row) });
  } catch (error) {
    const mapped = applicationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/applications/[id]/status", handlePOST);
