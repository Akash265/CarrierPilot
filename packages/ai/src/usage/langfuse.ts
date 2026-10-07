import type { Env } from "@ai-career/config";
import type { AiCallEvent, AiUsageSink } from "./types";

/**
 * Optional Langfuse export (Phase 11a design §6, revised during planning). Langfuse's v3 batch ingestion
 * API (/api/public/ingestion) is deprecated and shut down on Langfuse Cloud on 2026-11-16 for everything
 * but scores, so each call is sent as one OpenTelemetry span (OTLP/HTTP JSON) to /api/public/otel/v1/traces
 * -- a plain fetch, no SDK. Metadata only: never input/output/prompt/response text (CLAUDE.md §9).
 */
export type LangfuseEnv = Partial<Pick<Env, "LANGFUSE_HOST" | "LANGFUSE_PUBLIC_KEY" | "LANGFUSE_SECRET_KEY">>;

export interface LangfuseExportDeps {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** Process-local count of failed exports, reported by GET /api/health. Never persisted. */
let exportFailures = 0;
export const getLangfuseExportFailures = (): number => exportFailures;
export const resetLangfuseExportFailures = (): void => {
  exportFailures = 0;
};

export function isLangfuseConfigured(env: LangfuseEnv): boolean {
  return Boolean(env.LANGFUSE_HOST && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
type OtlpAttribute = { key: string; value: OtlpValue };

const str = (key: string, value: string): OtlpAttribute => ({ key, value: { stringValue: value } });
const nanos = (ms: number): string => (BigInt(Math.round(ms)) * BigInt(1_000_000)).toString();

/** OTLP ExportTraceServiceRequest (JSON mapping) with one span per call. Exported for tests. */
export function buildOtlpPayload(event: AiCallEvent) {
  const hex = event.id.replace(/-/g, "").toLowerCase();
  const startMs = event.createdAt.getTime();
  const failed = event.outcome !== "ok";
  const attributes: OtlpAttribute[] = [
    str("langfuse.observation.type", "generation"),
    str("langfuse.trace.name", event.operation),
    str("langfuse.observation.model.name", event.model),
    str(
      "langfuse.observation.usage_details",
      JSON.stringify({
        input: event.inputTokens,
        output: event.outputTokens,
        cache_read_input_tokens: event.cacheReadTokens,
        cache_creation_input_tokens: event.cacheCreationTokens,
        web_search_requests: event.webSearchRequests,
      })
    ),
    str("langfuse.observation.cost_details", JSON.stringify({ total: event.estimatedCostUsd })),
    str("langfuse.observation.level", event.outcome === "ok" ? "DEFAULT" : event.outcome === "blocked" ? "WARNING" : "ERROR"),
    str("langfuse.observation.metadata.provider", event.provider),
    str("langfuse.observation.metadata.outcome", event.outcome),
    { key: "langfuse.observation.metadata.price_known", value: { boolValue: event.priceKnown } },
  ];
  if (event.errorCode) {
    attributes.push(str("langfuse.observation.status_message", event.errorCode));
    attributes.push(str("langfuse.observation.metadata.error_code", event.errorCode));
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", "careerpilot")] },
        scopeSpans: [
          {
            scope: { name: "careerpilot.ai-usage" },
            spans: [
              {
                traceId: hex,
                spanId: hex.slice(0, 16),
                name: event.operation,
                kind: 3,
                startTimeUnixNano: nanos(startMs),
                endTimeUnixNano: nanos(startMs + event.latencyMs),
                attributes,
                status: failed ? { code: 2, message: event.errorCode ?? event.outcome } : { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Wraps a sink: `record` writes to the inner sink first (the ai_calls row is the source of truth), then
 * fires the export without awaiting it. Export failures are counted, never thrown or logged with content.
 * Returns the inner sink unchanged when Langfuse is not configured.
 */
export function withLangfuseExport(inner: AiUsageSink, env: LangfuseEnv, deps: LangfuseExportDeps = {}): AiUsageSink {
  if (!isLangfuseConfigured(env)) return inner;
  const url = `${env.LANGFUSE_HOST!.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
  const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const fetchFn = deps.fetchFn ?? ((u: string, init: RequestInit) => fetch(u, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const exportEvent = async (event: AiCallEvent): Promise<void> => {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", "x-langfuse-ingestion-version": "4" },
        body: JSON.stringify(buildOtlpPayload(event)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) exportFailures++;
      // The body is never needed; cancelling it releases the connection back to the pool.
      await response.body?.cancel().catch(() => undefined);
    } catch {
      exportFailures++;
    }
  };

  return {
    spendSinceUsd: (since) => inner.spendSinceUsd(since),
    record: async (event) => {
      await inner.record(event);
      void exportEvent(event);
    },
  };
}
