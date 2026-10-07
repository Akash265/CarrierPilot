import { randomUUID } from "node:crypto";
import { log } from "../log";
import { refreshWebRedactions } from "../webLogging";

export interface RouteErrorDeps {
  refreshRedactions: () => Promise<void>;
}

/**
 * Phase 11b design §4.1. Wraps a route handler so an error that escapes it never reaches Next.js's default handler
 * (which prints the raw message): it is logged as `request_failed` with the error's name, a code-like code and
 * repo-relative frames -- never its message -- plus the route pattern, method and scrubbed path (query string
 * dropped), and answered with a 500 carrying a request id. Responses the handler returns itself are untouched.
 */
export function makeWithRouteErrors(deps: RouteErrorDeps) {
  return function withRouteErrors<A extends unknown[]>(route: string, handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
    return async (...args: A) => {
      try {
        return await handler(...args);
      } catch (error) {
        const requestId = randomUUID().replace(/-/g, "").slice(0, 8);
        try {
          await deps.refreshRedactions();
        } catch {
          // Scrubbing still applies with the values already loaded (and the email pattern).
        }
        const request = args[0] instanceof Request ? args[0] : null;
        log.error("request_failed", {
          requestId,
          route,
          ...(request ? { method: request.method, path: new URL(request.url).pathname } : {}),
          error,
        });
        return Response.json(
          { error: `Something went wrong (request ${requestId}). Details are in the server log.`, requestId },
          { status: 500, headers: { "x-request-id": requestId } }
        );
      }
    };
  };
}

export const withRouteErrors = makeWithRouteErrors({ refreshRedactions: refreshWebRedactions });
