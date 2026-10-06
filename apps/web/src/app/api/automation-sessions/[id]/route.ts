import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { getSession } from "@ai-career/browser";
import { toSessionView } from "../../../../lib/browser-automation/serializeSession";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Autofill session not found" }, { status: 404 });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await getSession(db, env.DEFAULT_USER_ID, id);
    return row ? NextResponse.json({ session: toSessionView(row) }) : notFound();
  } finally {
    await closeDbClient(db);
  }
}
