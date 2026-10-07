import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { loadStatus } from "../../../lib/status/loadStatus";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

/** Phase 11b design §5.3: workers' heartbeats and queue health for /status. Always 200; outages are reported in the body. */
async function handleGET() {
  return NextResponse.json(await loadStatus(loadEnv()));
}

export const GET = withRouteErrors("/api/status", handleGET);
