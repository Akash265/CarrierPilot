import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { ConfirmedProfileSchema } from "../../../../lib/profile/confirmedProfileSchema";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { saveConfirmedProfile } from "../../../../lib/profile/saveProfile";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

async function handlePOST(request: Request) {
  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = ConfirmedProfileSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }
  // saveConfirmedProfile creates and closes its own connection pool, so this
  // route never opens one of its own (see packages/db/src/client.ts).
  const result = await saveConfirmedProfile(env, parsed.data);
  return NextResponse.json({ status: "saved", factsGenerated: result.factsGenerated });
}

export const POST = withRouteErrors("/api/profile/confirm", handlePOST);
