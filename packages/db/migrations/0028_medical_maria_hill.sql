CREATE TABLE IF NOT EXISTS "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"estimated_cost_usd" numeric(12, 6) NOT NULL,
	"price_known" boolean NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	CONSTRAINT "ai_calls_provider_valid" CHECK ("ai_calls"."provider" IN ('anthropic', 'voyage')),
	CONSTRAINT "ai_calls_outcome_valid" CHECK ("ai_calls"."outcome" IN ('ok', 'api_error', 'blocked')),
	CONSTRAINT "ai_calls_counts_non_negative" CHECK ("ai_calls"."input_tokens" >= 0 AND "ai_calls"."output_tokens" >= 0 AND "ai_calls"."cache_read_tokens" >= 0 AND "ai_calls"."cache_creation_tokens" >= 0 AND "ai_calls"."web_search_requests" >= 0 AND "ai_calls"."latency_ms" >= 0),
	CONSTRAINT "ai_calls_cost_non_negative" CHECK ("ai_calls"."estimated_cost_usd" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_calls_user_created_idx" ON "ai_calls" USING btree ("user_id","created_at" DESC NULLS LAST);