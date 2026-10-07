import { withRouteErrors } from "../../../lib/http/withRouteErrors";
import { gateConfig } from "../../../lib/security/gate";
import { handleUnlock } from "../../../lib/security/unlock";
import { log } from "../../../lib/log";

/** Phase 11c (D177): exchanges APP_ACCESS_TOKEN for the access cookie. Exempt from the token check in proxy.ts. */
async function handlePOST(request: Request): Promise<Response> {
  return handleUnlock(request, gateConfig(), log);
}

export const POST = withRouteErrors("/api/unlock", handlePOST);
