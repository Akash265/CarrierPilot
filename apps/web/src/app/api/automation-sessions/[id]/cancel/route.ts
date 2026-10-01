import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { requestCancel } from "@ai-career/browser";
import { toSessionView } from "../../../../../lib/browser-automation/serializeSession";
import { automationErrorResponse } from "../../../../../lib/browser-automation/errorResponse";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Autofill session not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await requestCancel(db, env.DEFAULT_USER_ID, id);
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    const mapped = automationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
