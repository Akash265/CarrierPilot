import { createLogger } from "@ai-career/logging";

/** The web app's logger (Phase 11b). Level and D9 values are process-wide; see lib/http/withRouteErrors.ts. */
export const log = createLogger({ service: "web" });
