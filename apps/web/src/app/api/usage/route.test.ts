import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb } from "../../../test/jobsDb";

// Phase 11a test user …0b04 (verified unused repo-wide on 2026-10-07); …0b05 is another user's row.
const USER = "00000000-0000-0000-0000-000000000b04";
const OTHER = "00000000-0000-0000-0000-000000000b05";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000b04",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    AI_MONTHLY_BUDGET_USD: 2,
    AI_BUDGET_WARN_PERCENT: 80,
  }),
}));

let admin: postgres.Sql;
const wipe = () => admin`DELETE FROM ai_calls WHERE user_id IN (${USER}, ${OTHER})`;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await admin.end();
});

async function insertCall(userId: string, o: { createdAt: Date; operation: string; cost: number; outcome?: string; errorCode?: string | null }) {
  await admin`
    INSERT INTO ai_calls (user_id, created_at, operation, provider, model, input_tokens, output_tokens, latency_ms, estimated_cost_usd, price_known, outcome, error_code)
    VALUES (${userId}, ${o.createdAt.toISOString()}::timestamptz, ${o.operation}, 'anthropic', 'claude-haiku-4-5-20251001', 10, 5, 100, ${o.cost}, true,
            ${o.outcome ?? "ok"}, ${o.errorCode ?? null})`;
}

const { GET } = await import("./route");

describe("GET /api/usage", () => {
  it("summarizes only this UTC month's calls for the current user", async () => {
    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 1));
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1000);
    await insertCall(USER, { createdAt: thisMonth, operation: "pitch_generation", cost: 1.25 });
    await insertCall(USER, { createdAt: thisMonth, operation: "pitch_generation", cost: 0, outcome: "blocked", errorCode: "budget_exceeded" });
    await insertCall(USER, { createdAt: lastMonth, operation: "pitch_generation", cost: 50 });
    await insertCall(OTHER, { createdAt: thisMonth, operation: "pitch_generation", cost: 9 });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({ ceilingUsd: 2, warnPercent: 80, spentUsd: 1.25, state: "ok" });
    expect(body.byOperation).toEqual([
      { operation: "pitch_generation", calls: 1, blocked: 1, failed: 0, inputTokens: 20, outputTokens: 10, webSearches: 0, costUsd: 1.25 },
    ]);
    expect(body.recentFailures).toEqual([
      { createdAt: thisMonth.toISOString(), operation: "pitch_generation", model: "claude-haiku-4-5-20251001", outcome: "blocked", errorCode: "budget_exceeded" },
    ]);
  });

  it("reports warn and over against the configured ceiling", async () => {
    await insertCall(USER, { createdAt: new Date(), operation: "match_explanation", cost: 1.6 });
    expect((await (await GET()).json()).state).toBe("warn");
    await insertCall(USER, { createdAt: new Date(), operation: "match_explanation", cost: 0.4 });
    expect((await (await GET()).json()).state).toBe("over");
  });
});
