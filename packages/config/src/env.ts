import { z } from "zod";

/** An empty or whitespace-only value (e.g. `AI_MONTHLY_BUDGET_USD=` in .env) counts as unset, so it gets the default. */
const blankAsUnset = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DEFAULT_USER_ID: z.string().uuid(),
    DATABASE_URL: z.string().url(),
    // Optional in the shared schema: only `packages/db/drizzle.config.ts`
    // (run standalone by drizzle-kit, never by the Next.js app or workers)
    // needs the superuser DSN. Keeping it optional here means the app/worker
    // processes are never required to hold this credential in their
    // environment at all — see DECISIONS.md D12.
    MIGRATIONS_DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url(),
    MINIO_ENDPOINT: z.string().url(),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    EMBEDDING_PROVIDER: z.enum(["voyage", "self-hosted"]),
    VOYAGE_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL_FAST: z.string().min(1),
    // Phase 7a company research. A separate role/tier (D7): research uses the basic
    // `web_search_20250305` tool (D79 -- the newer 20260209 tool's dynamic filtering strips
    // citations, producing 0 facts). A separate tier is kept for research quality, not because
    // the fast-tier Haiku model can't run this tool -- it can.
    ANTHROPIC_MODEL_RESEARCH: z.string().min(1),
    VOYAGE_EMBEDDING_MODEL: z.string().min(1),
    // Phase 4 ingestion. The API bases are operator-controlled (never user
    // input), which is what keeps the adapters SSRF-safe; overriding them is how
    // the E2E fake ATS server is used. See DECISIONS.md D3.
    GREENHOUSE_API_BASE: z.string().url().default("https://boards-api.greenhouse.io"),
    LEVER_API_BASE: z.string().url().default("https://api.lever.co"),
    INGEST_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(360),
    // Phase 5 matching. All tunable, none yet backed by labeled data (design doc §10).
    MATCHING_EXPLAIN_TOP_N: z.coerce.number().int().min(1).max(200).default(25),
    MATCHING_EXPERIENCE_GRACE_YEARS: z.coerce.number().min(0).max(10).default(1),
    MATCHING_FRESHNESS_HALF_LIFE_HOURS: z.coerce.number().min(1).default(168),
    MATCHING_EXPLANATION_TTL_DAYS: z.coerce.number().min(1).default(7),
    // Phase 7a: web searches allowed per company-research call (the tool's max_uses). Bounds cost.
    COMPANY_RESEARCH_MAX_SEARCHES: z.coerce.number().int().min(1).max(20).default(5),
    // Phase 9: days after an application reaches a terminal status before its job's generated documents
    // are deleted (architecture §9). 0 disables the retention sweep entirely.
    RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
    // Phase 10a insights. An open application with no activity for this many days counts as "no response" /
    // "no interview" (spec §4.2); a later response flips it back, since labels are computed on read.
    OUTCOME_UNDECIDED_DAYS: z.coerce.number().int().min(1).default(30),
    // Phase 10a insights. Fewer decided applications than this in a bucket shows counts only, never a rate.
    INSIGHTS_MIN_BUCKET: z.coerce.number().int().min(2).default(5),
    // Phase 10b personal response model gate (spec §4.3): decided applications with eligible-match factor scores
    // needed before the model is evaluated at all, and the minimum of each class (responses / non-responses).
    OUTCOME_MODEL_MIN_DECIDED: z.coerce.number().int().min(10).default(30),
    OUTCOME_MODEL_MIN_PER_CLASS: z.coerce.number().int().min(3).default(8),
    // Phase 8 browser automation (services/browser-worker only). Chrome is found via Playwright's
    // channel "chrome" unless an explicit executable path is given. Headless is for tests: the whole
    // point of a session is a visible window the user finishes and submits.
    BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
    BROWSER_HEADLESS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    BROWSER_SESSION_TIMEOUT_MIN: z.coerce.number().int().min(1).max(240).default(30),
    // Phase 11a AI cost control (design §5). Monthly ceiling on ESTIMATED AI spend in USD; 0 = no ceiling.
    // Blank must fall back to the default: z.coerce.number("") is 0, which would silently mean "unlimited".
    AI_MONTHLY_BUDGET_USD: z.preprocess(blankAsUnset, z.coerce.number().finite().min(0).default(20)),
    AI_BUDGET_WARN_PERCENT: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(100).default(80)),
    // Phase 11a optional Langfuse export (design §6): metadata only. All three or none (checked below).
    LANGFUSE_HOST: z.preprocess(blankAsUnset, z.string().url().regex(/^https?:\/\//i, "must be an http(s) URL").optional()),
    LANGFUSE_PUBLIC_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    LANGFUSE_SECRET_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    // Phase 11b (design §3, §5.2). Minimum level the structured logger writes, and how long a worker may go without
    // a heartbeat (they beat every 30 s) before /status calls it "stale".
    LOG_LEVEL: z.preprocess(blankAsUnset, z.enum(["debug", "info", "warn", "error"]).default("info")),
    STATUS_STALE_AFTER_MS: z.preprocess(blankAsUnset, z.coerce.number().int().min(1000).default(90_000)),
  })
  .superRefine((val, ctx) => {
    if (val.EMBEDDING_PROVIDER === "voyage" && !val.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VOYAGE_API_KEY"],
        message: "VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage",
      });
    }
    const langfuse = { LANGFUSE_HOST: val.LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY: val.LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY: val.LANGFUSE_SECRET_KEY };
    const missing = Object.entries(langfuse).filter(([, v]) => v === undefined).map(([k]) => k);
    if (missing.length > 0 && missing.length < 3) {
      for (const key of missing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "set all of LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, or none of them",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return result.data;
}
