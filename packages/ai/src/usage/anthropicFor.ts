import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "@ai-career/config";
import type { BudgetEnv } from "./budget";
import { trackAiCall } from "./track";
import type { AiOperation, AiUsageSink, UsageCounts } from "./types";

/**
 * The only Anthropic surface generators receive (Phase 11a): non-streaming `messages.create`. Narrower than
 * `Pick<Anthropic, "messages">` on purpose -- an untracked `stream()`, `countTokens()` or `batches` call is
 * a compile error, not a silent hole in the budget. A real SDK client is assignable to it.
 */
export interface MessagesClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<Anthropic.Message>;
  };
}

/** A pipeline that makes several kinds of call asks for a client per operation, so each row is labelled. */
export type AnthropicFor = (operation: AiOperation) => MessagesClient;

export interface AnthropicForDeps {
  /** Tests inject a fake; production builds one SDK client from ANTHROPIC_API_KEY (its own 2 retries apply). */
  client?: MessagesClient;
  clock?: () => number;
}

export function anthropicErrorCode(error: unknown): string {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "anthropic:timeout";
  if (error instanceof Anthropic.APIUserAbortError) return "anthropic:aborted";
  if (error instanceof Anthropic.APIConnectionError) return "anthropic:connection";
  if (error instanceof Anthropic.APIError) return `anthropic:${error.status ?? "unknown"}`;
  return "error";
}

/** A response without usage is charged its full output allowance (max_tokens), so it can never look free. */
function usageOf(message: Anthropic.Message, maxTokens: number): { usage: UsageCounts; usageReported: boolean } {
  const u = message.usage;
  if (!u) {
    return { usage: { inputTokens: 0, outputTokens: maxTokens, cacheReadTokens: 0, cacheCreationTokens: 0, webSearchRequests: 0 }, usageReported: false };
  }
  return {
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      webSearchRequests: u.server_tool_use?.web_search_requests ?? 0,
    },
    usageReported: true,
  };
}

export function createAnthropicFor(
  env: Pick<Env, "ANTHROPIC_API_KEY"> & BudgetEnv,
  sink: AiUsageSink,
  deps: AnthropicForDeps = {}
): AnthropicFor {
  const client: MessagesClient = deps.client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const clock = deps.clock ?? Date.now;
  return (operation) => ({
    messages: {
      create: (body, options) =>
        trackAiCall(
          { sink, env, operation, provider: "anthropic", model: body.model, clock, errorCodeOf: anthropicErrorCode },
          async () => {
            const message = options === undefined ? await client.messages.create(body) : await client.messages.create(body, options);
            return { result: message, ...usageOf(message, body.max_tokens), servedModel: message.model || undefined };
          }
        ),
    },
  });
}
