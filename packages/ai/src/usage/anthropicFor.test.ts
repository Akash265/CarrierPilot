import { describe, it, expect, vi, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicFor, type MessagesClient } from "./anthropicFor";
import { AiBudgetExceededError } from "./budget";
import type { AiCallEvent, AiUsageSink } from "./types";

const PARAMS: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-haiku-4-5-20251001",
  max_tokens: 100,
  messages: [{ role: "user", content: "SENTINEL-PROMPT-TEXT" }],
};

const message = (usage: Partial<Anthropic.Usage> | null, model = "claude-haiku-4-5-20251001") =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "SENTINEL-RESPONSE-TEXT", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  }) as unknown as Anthropic.Message;

function recordingSink(spent = 0): AiUsageSink & { events: AiCallEvent[] } {
  const events: AiCallEvent[] = [];
  return { events, spendSinceUsd: vi.fn(async () => spent), record: vi.fn(async (e: AiCallEvent) => void events.push(e)) };
}

function fakeClient(impl: () => Promise<Anthropic.Message>): MessagesClient & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(impl);
  return { create, messages: { create } };
}

/** 1000, 1250, ... -- every call advances the clock by 250 ms. */
function steppingClock(start = Date.parse("2026-10-07T12:00:00Z")) {
  let t = start - 250;
  return () => (t += 250);
}

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test", AI_MONTHLY_BUDGET_USD: 20 };

afterEach(() => vi.restoreAllMocks());

describe("createAnthropicFor", () => {
  it("records an ok call with its operation, model, usage, latency and cost, and returns the message", async () => {
    const sink = recordingSink();
    const msg = message({
      input_tokens: 1_000_000, output_tokens: 200_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 2 },
    } as Anthropic.Usage);
    const client = fakeClient(async () => msg);
    const anthropicFor = createAnthropicFor(ENV, sink, { client, clock: steppingClock() });

    const result = await anthropicFor("career_goal_parse").messages.create(PARAMS);

    expect(result).toBe(msg);
    expect(client.create).toHaveBeenCalledWith(PARAMS);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      operation: "career_goal_parse",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      webSearchRequests: 2,
      latencyMs: 250,
      estimatedCostUsd: 2.02,
      priceKnown: true,
      outcome: "ok",
      errorCode: null,
      createdAt: new Date("2026-10-07T12:00:00Z"),
    });
    expect(sink.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("labels each call with the operation it was created for, sharing one underlying client", async () => {
    const sink = recordingSink();
    const client = fakeClient(async () => message({ input_tokens: 1, output_tokens: 1 } as Anthropic.Usage));
    const anthropicFor = createAnthropicFor(ENV, sink, { client });
    await anthropicFor("job_requirements_extraction").messages.create(PARAMS);
    await anthropicFor("resume_optimization").messages.create(PARAMS);
    expect(sink.events.map((e) => e.operation)).toEqual(["job_requirements_extraction", "resume_optimization"]);
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it("prices by the model that served the call when the response names one", async () => {
    const sink = recordingSink();
    const client = fakeClient(async () => message({ input_tokens: 1_000_000, output_tokens: 0 } as Anthropic.Usage, "claude-sonnet-5"));
    await createAnthropicFor(ENV, sink, { client })("pitch_generation").messages.create(PARAMS);
    expect(sink.events[0]).toMatchObject({ model: "claude-sonnet-5", estimatedCostUsd: 2 });
  });

  it("treats null cache fields and a missing server_tool_use as 0", async () => {
    const sink = recordingSink();
    const client = fakeClient(async () =>
      message({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null } as Anthropic.Usage)
    );
    await createAnthropicFor(ENV, sink, { client })("match_explanation").messages.create(PARAMS);
    expect(sink.events[0]).toMatchObject({ cacheReadTokens: 0, cacheCreationTokens: 0, webSearchRequests: 0, priceKnown: true });
  });

  it("never records a call without a usage block as free: it charges max_tokens of output and says it estimated", async () => {
    const sink = recordingSink();
    const client = fakeClient(async () => message(null));
    await createAnthropicFor(ENV, sink, { client })("match_explanation").messages.create(PARAMS);
    // PARAMS.max_tokens = 100 output tokens at Haiku's $5/MTok = $0.0005; the model is in the table, so priceKnown stays true.
    expect(sink.events[0]).toMatchObject({
      inputTokens: 0, outputTokens: 100, estimatedCostUsd: 0.0005, priceKnown: true, outcome: "ok", errorCode: "usage_estimated",
    });
  });

  it("records an api_error with a status code and rethrows the provider's original error", async () => {
    const sink = recordingSink();
    const apiError = new Anthropic.RateLimitError(429, undefined, "rate limited SENTINEL-PROMPT-TEXT", new Headers());
    const client = fakeClient(async () => { throw apiError; });
    const error = await createAnthropicFor(ENV, sink, { client, clock: steppingClock() })("pitch_generation")
      .messages.create(PARAMS)
      .catch((e: unknown) => e);
    expect(error).toBe(apiError);
    expect(sink.events[0]).toMatchObject({
      outcome: "api_error", errorCode: "anthropic:429", latencyMs: 250, estimatedCostUsd: 0, inputTokens: 0, model: PARAMS.model,
    });
  });

  it("codes connection failures and timeouts without their messages", async () => {
    const sink = recordingSink();
    const timeout = new Anthropic.APIConnectionTimeoutError();
    const connection = new Anthropic.APIConnectionError({ message: "socket hang up" });
    const plain = new TypeError("bug");
    for (const err of [timeout, connection, plain]) {
      const client = fakeClient(async () => { throw err; });
      await createAnthropicFor(ENV, sink, { client })("company_research").messages.create(PARAMS).catch(() => undefined);
    }
    expect(sink.events.map((e) => e.errorCode)).toEqual(["anthropic:timeout", "anthropic:connection", "error"]);
  });

  it("blocks at the ceiling without contacting the provider, recording a zero-cost blocked row", async () => {
    const sink = recordingSink(20);
    const client = fakeClient(async () => message({ input_tokens: 1, output_tokens: 1 } as Anthropic.Usage));
    const error = await createAnthropicFor(ENV, sink, { client })("cover_letter_generation").messages.create(PARAMS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiBudgetExceededError);
    expect(client.create).not.toHaveBeenCalled();
    expect(sink.events[0]).toMatchObject({
      outcome: "blocked", errorCode: "budget_exceeded", estimatedCostUsd: 0, latencyMs: 0, inputTokens: 0, operation: "cover_letter_generation",
    });
  });

  it("fails closed when the spend query throws: blocked row attempted, provider untouched, error rethrown", async () => {
    const dbDown = new Error("connection refused");
    const events: AiCallEvent[] = [];
    const sink: AiUsageSink = { spendSinceUsd: async () => { throw dbDown; }, record: async (e) => void events.push(e) };
    const client = fakeClient(async () => message({ input_tokens: 1, output_tokens: 1 } as Anthropic.Usage));
    const error = await createAnthropicFor(ENV, sink, { client })("resume_extraction").messages.create(PARAMS).catch((e: unknown) => e);
    expect(error).toBe(dbDown);
    expect(client.create).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ outcome: "blocked", errorCode: "budget_check_failed" });
  });

  it("skips the gate entirely with a 0 ceiling", async () => {
    const sink = recordingSink(1_000);
    const client = fakeClient(async () => message({ input_tokens: 1, output_tokens: 1 } as Anthropic.Usage));
    await createAnthropicFor({ ...ENV, AI_MONTHLY_BUDGET_USD: 0 }, sink, { client })("resume_extraction").messages.create(PARAMS);
    expect(sink.spendSinceUsd).not.toHaveBeenCalled();
    expect(sink.events[0].outcome).toBe("ok");
  });

  it("still returns the result when recording fails, logging only a code (no content)", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const msg = message({ input_tokens: 1, output_tokens: 1 } as Anthropic.Usage);
    const sink: AiUsageSink = {
      spendSinceUsd: async () => 0,
      record: async () => { throw Object.assign(new Error("insert failed SENTINEL-PROMPT-TEXT"), { code: "53300" }); },
    };
    const result = await createAnthropicFor(ENV, sink, { client: fakeClient(async () => msg) })("resume_extraction").messages.create(PARAMS);
    expect(result).toBe(msg);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = String(errorLog.mock.calls[0][0]);
    expect(JSON.parse(logged)).toEqual({ event: "ai_usage_record_failed", operation: "resume_extraction", code: "53300" });
    expect(logged).not.toContain("SENTINEL");
  });

  it("never puts prompt or response text into the recorded event", async () => {
    const sink = recordingSink();
    const client = fakeClient(async () => message({ input_tokens: 1, output_tokens: 1 } as Anthropic.Usage));
    await createAnthropicFor(ENV, sink, { client })("resume_extraction").messages.create(PARAMS);
    expect(JSON.stringify(sink.events)).not.toContain("SENTINEL");
  });

  it("builds a real SDK client from ANTHROPIC_API_KEY when none is injected", () => {
    const anthropicFor = createAnthropicFor(ENV, recordingSink());
    expect(typeof anthropicFor("resume_extraction").messages.create).toBe("function");
  });
});
