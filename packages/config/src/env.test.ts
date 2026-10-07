import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const validSource = {
  NODE_ENV: "test",
  DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000001",
  DATABASE_URL: "postgres://user:pass@localhost:5432/career_intel",
  MIGRATIONS_DATABASE_URL: "postgres://career_intel:career_intel@localhost:5432/career_intel",
  REDIS_URL: "redis://localhost:6379",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "minioadmin",
  MINIO_SECRET_KEY: "minioadmin",
  ANTHROPIC_API_KEY: "sk-ant-test",
  EMBEDDING_PROVIDER: "voyage",
  VOYAGE_API_KEY: "voyage-test-key",
  ANTHROPIC_MODEL_FAST: "claude-haiku-4-5-20251001",
  ANTHROPIC_MODEL_RESEARCH: "claude-sonnet-5",
  VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
};

describe("loadEnv", () => {
  it("parses a fully valid environment", () => {
    const env = loadEnv(validSource);
    expect(env.DEFAULT_USER_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(env.EMBEDDING_PROVIDER).toBe("voyage");
  });

  it("rejects a non-UUID DEFAULT_USER_ID", () => {
    expect(() =>
      loadEnv({ ...validSource, DEFAULT_USER_ID: "not-a-uuid" })
    ).toThrow(/DEFAULT_USER_ID/);
  });

  it("requires VOYAGE_API_KEY when EMBEDDING_PROVIDER is voyage", () => {
    const { VOYAGE_API_KEY, ...rest } = validSource;
    expect(() => loadEnv({ ...rest, EMBEDDING_PROVIDER: "voyage" })).toThrow(
      /VOYAGE_API_KEY/
    );
  });

  it("allows missing VOYAGE_API_KEY when EMBEDDING_PROVIDER is self-hosted", () => {
    const { VOYAGE_API_KEY, ...rest } = validSource;
    const env = loadEnv({ ...rest, EMBEDDING_PROVIDER: "self-hosted" });
    expect(env.EMBEDDING_PROVIDER).toBe("self-hosted");
  });

  it("rejects a missing required field with a readable message", () => {
    const { DATABASE_URL, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("allows a missing MIGRATIONS_DATABASE_URL (only drizzle.config.ts requires it narrowly)", () => {
    const { MIGRATIONS_DATABASE_URL, ...rest } = validSource;
    const env = loadEnv(rest);
    expect(env.MIGRATIONS_DATABASE_URL).toBeUndefined();
  });

  it("rejects a malformed MIGRATIONS_DATABASE_URL when one is present", () => {
    expect(() =>
      loadEnv({ ...validSource, MIGRATIONS_DATABASE_URL: "not-a-url" })
    ).toThrow(/MIGRATIONS_DATABASE_URL/);
  });

  it("rejects a missing ANTHROPIC_MODEL_FAST", () => {
    const { ANTHROPIC_MODEL_FAST, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/ANTHROPIC_MODEL_FAST/);
  });

  it("rejects a missing ANTHROPIC_MODEL_RESEARCH", () => {
    const { ANTHROPIC_MODEL_RESEARCH, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/ANTHROPIC_MODEL_RESEARCH/);
  });

  it("defaults COMPANY_RESEARCH_MAX_SEARCHES to 5", () => {
    expect(loadEnv(validSource).COMPANY_RESEARCH_MAX_SEARCHES).toBe(5);
  });

  it("coerces COMPANY_RESEARCH_MAX_SEARCHES and rejects values outside 1-20", () => {
    expect(loadEnv({ ...validSource, COMPANY_RESEARCH_MAX_SEARCHES: "3" }).COMPANY_RESEARCH_MAX_SEARCHES).toBe(3);
    expect(() => loadEnv({ ...validSource, COMPANY_RESEARCH_MAX_SEARCHES: "0" })).toThrow(/COMPANY_RESEARCH_MAX_SEARCHES/);
    expect(() => loadEnv({ ...validSource, COMPANY_RESEARCH_MAX_SEARCHES: "21" })).toThrow(/COMPANY_RESEARCH_MAX_SEARCHES/);
  });

  it("rejects a missing VOYAGE_EMBEDDING_MODEL", () => {
    const { VOYAGE_EMBEDDING_MODEL, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/VOYAGE_EMBEDDING_MODEL/);
  });

  it("defaults the ingestion settings and lets them be overridden", () => {
    const env = loadEnv(validSource);
    expect(env.GREENHOUSE_API_BASE).toBe("https://boards-api.greenhouse.io");
    expect(env.LEVER_API_BASE).toBe("https://api.lever.co");
    expect(env.INGEST_INTERVAL_MINUTES).toBe(360);

    const custom = loadEnv({ ...validSource, GREENHOUSE_API_BASE: "http://localhost:4010", INGEST_INTERVAL_MINUTES: "15" });
    expect(custom.GREENHOUSE_API_BASE).toBe("http://localhost:4010");
    expect(custom.INGEST_INTERVAL_MINUTES).toBe(15);
  });

  it("rejects a too-short ingestion interval and a malformed API base", () => {
    expect(() => loadEnv({ ...validSource, INGEST_INTERVAL_MINUTES: "1" })).toThrow(/INGEST_INTERVAL_MINUTES/);
    expect(() => loadEnv({ ...validSource, LEVER_API_BASE: "not-a-url" })).toThrow(/LEVER_API_BASE/);
  });

  it("defaults the matching settings and lets them be overridden", () => {
    const env = loadEnv(validSource);
    expect(env.MATCHING_EXPLAIN_TOP_N).toBe(25);
    expect(env.MATCHING_EXPERIENCE_GRACE_YEARS).toBe(1);
    expect(env.MATCHING_FRESHNESS_HALF_LIFE_HOURS).toBe(168);
    expect(env.MATCHING_EXPLANATION_TTL_DAYS).toBe(7);

    const custom = loadEnv({ ...validSource, MATCHING_EXPLAIN_TOP_N: "10" });
    expect(custom.MATCHING_EXPLAIN_TOP_N).toBe(10);
  });

  it("defaults RETENTION_DAYS to 30, accepts 0, and rejects negatives", () => {
    expect(loadEnv({ ...validSource }).RETENTION_DAYS).toBe(30);
    expect(loadEnv({ ...validSource, RETENTION_DAYS: "0" }).RETENTION_DAYS).toBe(0);
    expect(() => loadEnv({ ...validSource, RETENTION_DAYS: "-1" })).toThrow(/RETENTION_DAYS/);
  });

  it("parses the Phase 8 browser settings with safe defaults", () => {
    const env = loadEnv({ ...validSource });
    expect(env.BROWSER_HEADLESS).toBe(false);
    expect(env.BROWSER_SESSION_TIMEOUT_MIN).toBe(30);
    expect(env.BROWSER_EXECUTABLE_PATH).toBeUndefined();
    const custom = loadEnv({ ...validSource, BROWSER_HEADLESS: "true", BROWSER_SESSION_TIMEOUT_MIN: "5", BROWSER_EXECUTABLE_PATH: "/opt/chrome" });
    expect(custom).toMatchObject({ BROWSER_HEADLESS: true, BROWSER_SESSION_TIMEOUT_MIN: 5, BROWSER_EXECUTABLE_PATH: "/opt/chrome" });
    expect(() => loadEnv({ ...validSource, BROWSER_HEADLESS: "yes" })).toThrow(/BROWSER_HEADLESS/);
    expect(() => loadEnv({ ...validSource, BROWSER_SESSION_TIMEOUT_MIN: "0" })).toThrow(/BROWSER_SESSION_TIMEOUT_MIN/);
  });

  it("defaults the Phase 10a insights settings", () => {
    const env = loadEnv(validSource);
    expect(env.OUTCOME_UNDECIDED_DAYS).toBe(30);
    expect(env.INSIGHTS_MIN_BUCKET).toBe(5);
  });

  it("parses and bounds the Phase 10a insights settings", () => {
    const env = loadEnv({ ...validSource, OUTCOME_UNDECIDED_DAYS: "45", INSIGHTS_MIN_BUCKET: "8" });
    expect(env.OUTCOME_UNDECIDED_DAYS).toBe(45);
    expect(env.INSIGHTS_MIN_BUCKET).toBe(8);
    expect(() => loadEnv({ ...validSource, OUTCOME_UNDECIDED_DAYS: "0" })).toThrow(/OUTCOME_UNDECIDED_DAYS/);
    expect(() => loadEnv({ ...validSource, INSIGHTS_MIN_BUCKET: "1" })).toThrow(/INSIGHTS_MIN_BUCKET/);
    expect(() => loadEnv({ ...validSource, INSIGHTS_MIN_BUCKET: "2.5" })).toThrow(/INSIGHTS_MIN_BUCKET/);
  });

  it("defaults the Phase 10b response-model gate", () => {
    const env = loadEnv(validSource);
    expect(env.OUTCOME_MODEL_MIN_DECIDED).toBe(30);
    expect(env.OUTCOME_MODEL_MIN_PER_CLASS).toBe(8);
  });

  it("parses and bounds the Phase 10b response-model gate", () => {
    const env = loadEnv({ ...validSource, OUTCOME_MODEL_MIN_DECIDED: "50", OUTCOME_MODEL_MIN_PER_CLASS: "12" });
    expect(env.OUTCOME_MODEL_MIN_DECIDED).toBe(50);
    expect(env.OUTCOME_MODEL_MIN_PER_CLASS).toBe(12);
    expect(() => loadEnv({ ...validSource, OUTCOME_MODEL_MIN_DECIDED: "9" })).toThrow(/OUTCOME_MODEL_MIN_DECIDED/);
    expect(() => loadEnv({ ...validSource, OUTCOME_MODEL_MIN_PER_CLASS: "2" })).toThrow(/OUTCOME_MODEL_MIN_PER_CLASS/);
  });

  it("defaults the Phase 11a AI budget settings", () => {
    const env = loadEnv(validSource);
    expect(env.AI_MONTHLY_BUDGET_USD).toBe(20);
    expect(env.AI_BUDGET_WARN_PERCENT).toBe(80);
  });

  it("parses and bounds the Phase 11a AI budget settings", () => {
    const env = loadEnv({ ...validSource, AI_MONTHLY_BUDGET_USD: "7.5", AI_BUDGET_WARN_PERCENT: "90" });
    expect(env.AI_MONTHLY_BUDGET_USD).toBe(7.5);
    expect(env.AI_BUDGET_WARN_PERCENT).toBe(90);
    expect(loadEnv({ ...validSource, AI_MONTHLY_BUDGET_USD: "0" }).AI_MONTHLY_BUDGET_USD).toBe(0);
    expect(() => loadEnv({ ...validSource, AI_MONTHLY_BUDGET_USD: "-1" })).toThrow(/AI_MONTHLY_BUDGET_USD/);
    expect(() => loadEnv({ ...validSource, AI_MONTHLY_BUDGET_USD: "abc" })).toThrow(/AI_MONTHLY_BUDGET_USD/);
    expect(() => loadEnv({ ...validSource, AI_BUDGET_WARN_PERCENT: "0" })).toThrow(/AI_BUDGET_WARN_PERCENT/);
    expect(() => loadEnv({ ...validSource, AI_BUDGET_WARN_PERCENT: "101" })).toThrow(/AI_BUDGET_WARN_PERCENT/);
    expect(() => loadEnv({ ...validSource, AI_BUDGET_WARN_PERCENT: "80.5" })).toThrow(/AI_BUDGET_WARN_PERCENT/);
  });

  it("treats an empty AI budget value as unset, never as an unlimited 0", () => {
    const env = loadEnv({ ...validSource, AI_MONTHLY_BUDGET_USD: "", AI_BUDGET_WARN_PERCENT: "  " });
    expect(env.AI_MONTHLY_BUDGET_USD).toBe(20);
    expect(env.AI_BUDGET_WARN_PERCENT).toBe(80);
  });

  it("leaves Langfuse export off when no LANGFUSE_* variable is set (empty counts as unset)", () => {
    expect(loadEnv(validSource).LANGFUSE_HOST).toBeUndefined();
    const env = loadEnv({ ...validSource, LANGFUSE_HOST: "", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" });
    expect(env.LANGFUSE_HOST).toBeUndefined();
    expect(env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
    expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
  });

  it("accepts a complete Langfuse configuration", () => {
    const env = loadEnv({
      ...validSource,
      LANGFUSE_HOST: "https://cloud.langfuse.com",
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
    });
    expect(env.LANGFUSE_HOST).toBe("https://cloud.langfuse.com");
    expect(env.LANGFUSE_PUBLIC_KEY).toBe("pk-lf-test");
    expect(env.LANGFUSE_SECRET_KEY).toBe("sk-lf-test");
  });

  it("rejects a partial Langfuse configuration, naming the missing variables", () => {
    expect(() => loadEnv({ ...validSource, LANGFUSE_PUBLIC_KEY: "pk-lf-test" })).toThrow(
      /LANGFUSE_HOST.*LANGFUSE_SECRET_KEY|LANGFUSE_SECRET_KEY.*LANGFUSE_HOST/
    );
    expect(() =>
      loadEnv({ ...validSource, LANGFUSE_HOST: "https://cloud.langfuse.com", LANGFUSE_SECRET_KEY: "sk-lf-test" })
    ).toThrow(/LANGFUSE_PUBLIC_KEY/);
  });

  it("rejects a non-http(s) LANGFUSE_HOST", () => {
    expect(() =>
      loadEnv({ ...validSource, LANGFUSE_HOST: "ftp://x.example", LANGFUSE_PUBLIC_KEY: "p", LANGFUSE_SECRET_KEY: "s" })
    ).toThrow(/LANGFUSE_HOST/);
  });
});
