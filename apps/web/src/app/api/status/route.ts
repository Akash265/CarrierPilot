import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { loadStatus, unavailableReport } from "../../../lib/status/loadStatus";
import { log } from "../../../lib/log";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

/** Phase 11b design §5.3: workers' heartbeats and queue health for /status. Always 200; outages are reported in the body. */
async function handleGET() {
  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
  } catch (error) {
    // An invalid configuration is itself something /status should show, not a 500 (the message is never logged).
    log.warn("status_config_invalid", { error });
    return NextResponse.json(unavailableReport());
  }
  return NextResponse.json(await loadStatus(env));
}

export const GET = withRouteErrors("/api/status", handleGET);
