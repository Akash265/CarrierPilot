import type { Instrumentation } from "next";
import { log } from "./log";
import { refreshWebRedactions } from "./webLogging";

type OnRequestErrorArgs = Parameters<Instrumentation.onRequestError>;

/**
 * Phase 11b design §4.3: errors Next.js captures outside our wrapped route handlers (page/server-component
 * rendering), logged the same message-free way as `request_failed`. Next.js still prints its own line for these;
 * our pages are client components fetching wrapped routes, so this path is rare.
 */
export async function logRenderFailure(error: OnRequestErrorArgs[0], request: OnRequestErrorArgs[1], context: OnRequestErrorArgs[2]): Promise<void> {
  await refreshWebRedactions();
  log.error("render_failed", {
    path: request.path.split("?")[0],
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    error,
  });
}
