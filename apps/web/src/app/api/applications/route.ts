import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import {
  APPLICATION_STATUSES, CreateApplicationBodySchema, createApplication, listApplications, todayUtc, type ApplicationStatus,
} from "@ai-career/applications";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { toApplicationView } from "../../../lib/applications/serializeApplication";
import { applicationErrorResponse } from "../../../lib/applications/errorResponse";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  if (status !== null && !(APPLICATION_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Unknown status" }, { status: 400 });
  }
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await listApplications(db, env.DEFAULT_USER_ID, {
      status: (status ?? undefined) as ApplicationStatus | undefined,
      dueOnly: params.get("due") === "1",
      today: todayUtc(new Date()),
    });
    return NextResponse.json({ applications: result.applications.map(toApplicationView), dueCount: result.dueCount });
  } finally {
    await closeDbClient(db);
  }
}

export async function POST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = CreateApplicationBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const row = await createApplication(db, env.DEFAULT_USER_ID, parsed.data);
    return NextResponse.json({ application: toApplicationView(row) }, { status: 201 });
  } catch (error) {
    const mapped = applicationErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
