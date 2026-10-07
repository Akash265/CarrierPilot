/**
 * Phase 11b design §4.3. Next.js also compiles this file for the Edge runtime, where the logger's Node streams do not
 * exist, so the Node-only code is imported only inside the Node.js branch (the pattern Next.js documents for
 * instrumentation); the Edge bundle drops it. No route runs on the Edge runtime today.
 */
import type { Instrumentation } from "next";

/** Phase 11c (D177): warn at startup if the app is reachable from the network without an access token. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupCheck } = await import("./lib/security/startupCheck");
  runStartupCheck();
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logRenderFailure } = await import("./lib/renderErrors");
  await logRenderFailure(error, request, context);
};
