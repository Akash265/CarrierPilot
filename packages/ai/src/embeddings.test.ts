import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embedTexts, EmbeddingProviderNotImplementedError, VoyageRequestError, type EmbedDeps } from "./embeddings";
import { AiBudgetExceededError } from "./usage/budget";
import type { AiCallEvent, AiUsageSink } from "./usage/types";

const ENV = { EMBEDDING_PROVIDER: "voyage" as const, VOYAGE_API_KEY: "key", VOYAGE_EMBEDDING_MODEL: "voyage-3.5", AI_MONTHLY_BUDGET_USD: 20 };

function recordingSink(spent = 0): AiUsageSink & { events: AiCallEvent[] } {
  const events: AiCallEvent[] = [];
  return { events, spendSinceUsd: vi.fn(async () => spent), record: vi.fn(async (e: AiCallEvent) => void events.push(e)) };
}

const okResponse = (embeddings: number[][], totalTokens: number | null = 42) =>
  new Response(
    JSON.stringify({ data: embeddings.map((embedding) => ({ embedding })), ...(totalTokens === null ? {} : { usage: { total_tokens: totalTokens } }) }),
    { status: 200 }
  );
const errorResponse = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ detail: "SENTINEL-FACT-TEXT echoed" }), { status, headers });

function deps(responses: (Response | Error)[]): EmbedDeps & { fetchFn: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } {
  const queue = [...responses];
  return {
    fetchFn: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    }),
    sleep: vi.fn(async () => undefined),
    random: () => 0.5,
  };
}

// Every test injects fetchFn; a real network call from this file is always a bug.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("global fetch must not be used in embeddings tests"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("embedTexts", () => {
  it("returns an empty array without calling the API or recording anything for empty input", async () => {
    const sink = recordingSink();
    const d = deps([]);
    expect(await embedTexts(ENV, [], { sink, operation: "job_embedding" }, d)).toEqual([]);
    expect(d.fetchFn).not.toHaveBeenCalled();
    expect(sink.events).toEqual([]);
  });

  it("calls Voyage once, returns the embeddings and records one priced row", async () => {
    const sink = recordingSink();
    const d = deps([okResponse([[0.1, 0.2]], 500_000)]);
    const result = await embedTexts(ENV, ["SENTINEL-FACT-TEXT"], { sink, operation: "profile_fact_embedding" }, d);
    expect(result).toEqual([[0.1, 0.2]]);
    const [url, init] = d.fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(JSON.parse(init.body as string)).toEqual({ input: ["SENTINEL-FACT-TEXT"], model: "voyage-3.5" });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      operation: "profile_fact_embedding", provider: "voyage", model: "voyage-3.5", inputTokens: 500_000, outputTokens: 0,
      estimatedCostUsd: 0.03, priceKnown: true, outcome: "ok", errorCode: null,
    });
    expect(JSON.stringify(sink.events)).not.toContain("SENTINEL");
  });

  it("flags priceKnown false when Voyage reports no token usage", async () => {
    const sink = recordingSink();
    await embedTexts(ENV, ["t"], { sink, operation: "goal_embedding" }, deps([okResponse([[1]], null)]));
    expect(sink.events[0]).toMatchObject({ inputTokens: 0, estimatedCostUsd: 0, priceKnown: false, outcome: "ok" });
  });

  it("retries a 429 then succeeds: two attempts, one row, backoff 500ms", async () => {
    const sink = recordingSink();
    const d = deps([errorResponse(429), okResponse([[1]])]);
    expect(await embedTexts(ENV, ["t"], { sink, operation: "job_embedding" }, d)).toEqual([[1]]);
    expect(d.fetchFn).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(500);
    expect(sink.events.map((e) => e.outcome)).toEqual(["ok"]);
  });

  it("honours a numeric retry-after header, capped at 30 s", async () => {
    const d1 = deps([errorResponse(503, { "retry-after": "2" }), okResponse([[1]])]);
    await embedTexts(ENV, ["t"], { sink: recordingSink(), operation: "job_embedding" }, d1);
    expect(d1.sleep).toHaveBeenCalledWith(2000);
    const d2 = deps([errorResponse(429, { "retry-after": "120" }), okResponse([[1]])]);
    await embedTexts(ENV, ["t"], { sink: recordingSink(), operation: "job_embedding" }, d2);
    expect(d2.sleep).toHaveBeenCalledWith(30_000);
  });

  it("falls back to exponential backoff when retry-after is an HTTP date or garbage", async () => {
    const d = deps([
      errorResponse(503, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      errorResponse(503, { "retry-after": "soon" }),
      okResponse([[1]]),
    ]);
    await embedTexts(ENV, ["t"], { sink: recordingSink(), operation: "job_embedding" }, d);
    expect(d.sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it("backs off exponentially (with jitter) and gives up after 3 attempts on 5xx, recording one api_error", async () => {
    const sink = recordingSink();
    const d = deps([errorResponse(500), errorResponse(502), errorResponse(503)]);
    d.random = () => 1; // +20% jitter
    const error = await embedTexts(ENV, ["t"], { sink, operation: "job_embedding" }, d).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoyageRequestError);
    expect((error as Error).message).toBe("Voyage embeddings request failed: 503");
    expect((error as Error).message).not.toContain("SENTINEL");
    expect(d.fetchFn).toHaveBeenCalledTimes(3);
    expect(d.sleep.mock.calls.map((c) => c[0])).toEqual([600, 1200]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ outcome: "api_error", errorCode: "voyage:503" });
  });

  it("never retries a non-429 4xx", async () => {
    const sink = recordingSink();
    const d = deps([errorResponse(401)]);
    await expect(embedTexts(ENV, ["t"], { sink, operation: "job_embedding" }, d)).rejects.toThrow(/Voyage embeddings request failed: 401/);
    expect(d.fetchFn).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
    expect(sink.events[0]).toMatchObject({ outcome: "api_error", errorCode: "voyage:401" });
  });

  it("retries network errors and codes a final one as network", async () => {
    const sink = recordingSink();
    const d = deps([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    await expect(embedTexts(ENV, ["t"], { sink, operation: "job_embedding" }, d)).rejects.toThrow("fetch failed");
    expect(d.fetchFn).toHaveBeenCalledTimes(3);
    expect(sink.events[0]).toMatchObject({ outcome: "api_error", errorCode: "network" });
  });

  it("checks the budget once, before the first attempt, and never calls Voyage when blocked", async () => {
    const sink = recordingSink(20);
    const d = deps([okResponse([[1]])]);
    await expect(embedTexts(ENV, ["t"], { sink, operation: "resume_similarity_embedding" }, d)).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(d.fetchFn).not.toHaveBeenCalled();
    expect(sink.events[0]).toMatchObject({ outcome: "blocked", provider: "voyage", errorCode: "budget_exceeded" });
  });

  it("checks the budget once even when retrying", async () => {
    const sink = recordingSink();
    await embedTexts(ENV, ["t"], { sink, operation: "job_embedding" }, deps([errorResponse(429), okResponse([[1]])]));
    expect(sink.spendSinceUsd).toHaveBeenCalledTimes(1);
  });

  it("throws for a non-voyage provider (not yet implemented) without recording", async () => {
    const sink = recordingSink();
    await expect(
      embedTexts({ ...ENV, EMBEDDING_PROVIDER: "self-hosted", VOYAGE_API_KEY: undefined }, ["text"], { sink, operation: "job_embedding" })
    ).rejects.toThrow(EmbeddingProviderNotImplementedError);
    expect(sink.events).toEqual([]);
  });
});
