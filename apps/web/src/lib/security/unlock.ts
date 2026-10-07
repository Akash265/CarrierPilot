import { NextResponse } from "next/server";
import { z } from "zod";
import type { Logger } from "@ai-career/logging";
import { readJsonBody } from "../readJsonBody";
import { ACCESS_COOKIE, accessCookieValue, sameSecret, type GateConfig } from "./gate";

const bodySchema = z.object({ token: z.string().min(1).max(1024) });
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

/** Phase 11c design §2.2 (D177): POST /api/unlock exchanges the access token for the gate's cookie. */
export async function handleUnlock(request: Request, cfg: GateConfig, logger: Logger): Promise<Response> {
  if (!cfg.token) return NextResponse.json({ error: "No access token is configured" }, { status: 404 });
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) return NextResponse.json({ error: "Body must be { token: string }" }, { status: 400 });
  if (!sameSecret(body.data.token, cfg.token)) {
    logger.warn("unlock_failed", {});
    return NextResponse.json({ error: "Wrong access token" }, { status: 401 });
  }
  const https = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(ACCESS_COOKIE, accessCookieValue(cfg.token), {
    httpOnly: true, sameSite: "strict", path: "/", maxAge: THIRTY_DAYS_S, secure: https,
  });
  return res;
}
