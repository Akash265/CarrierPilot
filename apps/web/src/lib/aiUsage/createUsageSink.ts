import type { Env } from "@ai-career/config";
import { DbUsageSink, type DbClient } from "@ai-career/db";
import { withLangfuseExport, type AiUsageSink } from "@ai-career/ai";

/**
 * The single place the web app builds its AI usage sink (Phase 11a): ai_calls rows for the local user,
 * plus the metadata-only Langfuse export when LANGFUSE_* is configured. Typed as AiUsageSink, so the
 * compiler checks DbUsageSink still matches the AI package's interface.
 */
export function createUsageSink(db: DbClient, env: Env): AiUsageSink {
  const sink: AiUsageSink = new DbUsageSink(db, env.DEFAULT_USER_ID);
  return withLangfuseExport(sink, env);
}
