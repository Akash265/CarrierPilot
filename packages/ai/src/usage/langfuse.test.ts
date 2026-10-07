import { describe, it, expect, vi } from "vitest";
import {
  buildOtlpPayload, getLangfuseExportFailures, isLangfuseConfigured, resetLangfuseExportFailures, withLangfuseExport,
} from "./langfuse";
import type { AiCallEvent, AiUsageSink } from "./types";

const EVENT: AiCallEvent = {
  id: "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b",
  createdAt: new Date("2026-10-07T12:00:00.000Z"),
  operation: "pitch_generation",
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 10,
  cacheCreationTokens: 20,
  webSearchRequests: 0,
  latencyMs: 1500,
  estimatedCostUsd: 0.0027,
  priceKnown: true,
  outcome: "ok",
  errorCode: null,
};

const LANGFUSE_ENV = {
  LANGFUSE_HOST: "https://langfuse.example.com/",
  LANGFUSE_PUBLIC_KEY: "pk-lf-1",
  LANGFUSE_SECRET_KEY: "sk-lf-1",
};

function innerSink(): AiUsageSink & { recorded: AiCallEvent[] } {
  const recorded: AiCallEvent[] = [];
  return { recorded, spendSinceUsd: vi.fn(async () => 3.5), record: vi.fn(async (e: AiCallEvent) => void recorded.push(e)) };
}

type Attr = { key: string; value: Record<string, unknown> };
const attrsOf = (payload: ReturnType<typeof buildOtlpPayload>): Record<string, unknown> =>
  Object.fromEntries(
    (payload.resourceSpans[0].scopeSpans[0].spans[0].attributes as Attr[]).map((a) => [a.key, Object.values(a.value)[0]])
  );

describe("buildOtlpPayload", () => {
  it("maps one call to one Langfuse generation span with ids derived from the ai_calls id", () => {
    const payload = buildOtlpPayload(EVENT);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe("3f2b8c1e9a4d4e6f8b2a1c3d5e7f9a0b");
    expect(span.spanId).toBe("3f2b8c1e9a4d4e6f");
    expect(span.name).toBe("pitch_generation");
    expect(span.startTimeUnixNano).toBe("1791374400000000000");
    expect(span.endTimeUnixNano).toBe("1791374401500000000");
    expect(span.status).toEqual({ code: 1 });
    expect(payload.resourceSpans[0].resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "careerpilot" } }]);
  });

  it("carries model, usage, cost and metadata as Langfuse attributes (JSON-encoded where Langfuse expects strings)", () => {
    const attrs = attrsOf(buildOtlpPayload(EVENT));
    expect(attrs["langfuse.observation.type"]).toBe("generation");
    expect(attrs["langfuse.trace.name"]).toBe("pitch_generation");
    expect(attrs["langfuse.observation.model.name"]).toBe("claude-haiku-4-5-20251001");
    expect(JSON.parse(attrs["langfuse.observation.usage_details"] as string)).toEqual({
      input: 1200, output: 300, cache_read_input_tokens: 10, cache_creation_input_tokens: 20, web_search_requests: 0,
    });
    expect(JSON.parse(attrs["langfuse.observation.cost_details"] as string)).toEqual({ total: 0.0027 });
    expect(attrs["langfuse.observation.metadata.provider"]).toBe("anthropic");
    expect(attrs["langfuse.observation.metadata.outcome"]).toBe("ok");
    expect(attrs["langfuse.observation.metadata.price_known"]).toBe(true);
    expect(attrs["langfuse.observation.level"]).toBe("DEFAULT");
    expect(attrs["langfuse.observation.metadata.error_code"]).toBeUndefined();
  });

  it("marks failures ERROR and blocked calls WARNING, with the short error code only", () => {
    const failed = attrsOf(buildOtlpPayload({ ...EVENT, outcome: "api_error", errorCode: "anthropic:529" }));
    expect(failed["langfuse.observation.level"]).toBe("ERROR");
    expect(failed["langfuse.observation.status_message"]).toBe("anthropic:529");
    expect(failed["langfuse.observation.metadata.error_code"]).toBe("anthropic:529");
    expect(buildOtlpPayload({ ...EVENT, outcome: "api_error", errorCode: "x" }).resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({
      code: 2,
      message: "x",
    });
    const blocked = attrsOf(buildOtlpPayload({ ...EVENT, outcome: "blocked", errorCode: "budget_exceeded", latencyMs: 0 }));
    expect(blocked["langfuse.observation.level"]).toBe("WARNING");
  });

  it("never sets input or output attributes", () => {
    const keys = Object.keys(attrsOf(buildOtlpPayload(EVENT)));
    expect(keys.filter((k) => /input|output|prompt|completion/.test(k) && !k.endsWith("usage_details"))).toEqual([]);
  });
});

describe("isLangfuseConfigured", () => {
  it("is true only with all three settings", () => {
    expect(isLangfuseConfigured(LANGFUSE_ENV)).toBe(true);
    expect(isLangfuseConfigured({ ...LANGFUSE_ENV, LANGFUSE_SECRET_KEY: undefined })).toBe(false);
    expect(isLangfuseConfigured({})).toBe(false);
  });
});

describe("withLangfuseExport", () => {
  it("returns the inner sink unchanged when Langfuse is not configured", () => {
    const inner = innerSink();
    expect(withLangfuseExport(inner, {})).toBe(inner);
  });

  it("records to the inner sink first, then posts OTLP JSON with basic auth and the v4 ingestion header", async () => {
    resetLangfuseExportFailures();
    const inner = innerSink();
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const sink = withLangfuseExport(inner, LANGFUSE_ENV, { fetchFn });
    await sink.record(EVENT);
    expect(inner.recorded).toEqual([EVENT]);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://langfuse.example.com/api/public/otel/v1/traces");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`,
      "Content-Type": "application/json",
      "x-langfuse-ingestion-version": "4",
    });
    expect(JSON.parse(init.body as string)).toEqual(buildOtlpPayload(EVENT));
    expect(getLangfuseExportFailures()).toBe(0);
  });

  it("delegates spendSinceUsd to the inner sink", async () => {
    const inner = innerSink();
    const sink = withLangfuseExport(inner, LANGFUSE_ENV, { fetchFn: vi.fn() });
    expect(await sink.spendSinceUsd(new Date())).toBe(3.5);
  });

  it("does not wait for the export: record resolves while the POST is still pending", async () => {
    const inner = innerSink();
    let release!: () => void;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response("{}")); }));
    const sink = withLangfuseExport(inner, LANGFUSE_ENV, { fetchFn });
    await sink.record(EVENT);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    release();
  });

  it("counts a non-2xx response or a network error as a failure and never throws", async () => {
    resetLangfuseExportFailures();
    const inner = innerSink();
    const sink401 = withLangfuseExport(inner, LANGFUSE_ENV, { fetchFn: vi.fn(async () => new Response("no", { status: 401 })) });
    const sinkDown = withLangfuseExport(inner, LANGFUSE_ENV, { fetchFn: vi.fn(async () => { throw new TypeError("fetch failed"); }) });
    await expect(sink401.record(EVENT)).resolves.toBeUndefined();
    await expect(sinkDown.record(EVENT)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(getLangfuseExportFailures()).toBe(2));
  });

  it("aborts an export that takes longer than the timeout and counts it", async () => {
    resetLangfuseExportFailures();
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    const sink = withLangfuseExport(innerSink(), LANGFUSE_ENV, { fetchFn, timeoutMs: 10 });
    await sink.record(EVENT);
    await vi.waitFor(() => expect(getLangfuseExportFailures()).toBe(1));
  });

  it("does not export when the inner record throws (the row does not exist)", async () => {
    const fetchFn = vi.fn();
    const failing: AiUsageSink = { spendSinceUsd: async () => 0, record: async () => { throw new Error("db"); } };
    await expect(withLangfuseExport(failing, LANGFUSE_ENV, { fetchFn }).record(EVENT)).rejects.toThrow("db");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
