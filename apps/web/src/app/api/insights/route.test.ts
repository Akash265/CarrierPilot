import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertModelHistory } from "../../../test/jobsDb";
import { clearResponseModelCache } from "../../../lib/insights/responseModel";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000a03",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    OUTCOME_UNDECIDED_DAYS: 30,
    INSIGHTS_MIN_BUCKET: 2,
    OUTCOME_MODEL_MIN_DECIDED: 30,
    OUTCOME_MODEL_MIN_PER_CLASS: 8,
  }),
}));

const USER = "00000000-0000-0000-0000-000000000a03";
const OTHER = "00000000-0000-0000-0000-000000000a04";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  clearResponseModelCache();
  await wipeMatchingData(admin, USER);
  await wipeMatchingData(admin, OTHER);
});
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await wipeMatchingData(admin, OTHER);
  await admin.end();
});

const { GET } = await import("./route");

const TERMINAL = new Set(["accepted", "declined", "rejected", "withdrawn", "no_response"]);

/** history: the to_status of each status_change event, oldest first; the last one is the current status. */
async function seed(userId: string, appliedDaysAgo: number, history: string[], notes = "SECRET NOTE"): Promise<void> {
  const status = history[history.length - 1];
  const [row] = await admin`
    INSERT INTO applications (user_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot, notes, terminal_at)
    VALUES (${userId}, 'Acme', 'Data Engineer', ${status}, now(), current_date - ${appliedDaysAgo}::int,
            '{"snapshotVersion":2,"external":true,"job":{},"match":null,"ats":null,"documents":null}'::jsonb, ${notes},
            ${TERMINAL.has(status) ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  // Like real data: only the creation event (the first one) has from_status null; later steps record the previous status.
  for (const [i, to] of history.entries()) {
    const from = i === 0 ? null : history[i - 1];
    await admin`
      INSERT INTO application_events (user_id, application_id, type, occurred_at, from_status, to_status)
      VALUES (${userId}, ${row.id}, 'status_change', (current_date - ${appliedDaysAgo}::int)::timestamptz + ${i}::int * interval '1 hour',
              ${from}, ${to})`;
  }
}

describe("GET /api/insights", () => {
  it("returns zero counts for a user with no applications", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ undecidedDays: 30, minBucket: 2 });
    expect(body.totals).toEqual({ applications: 0, external: 0 });
    expect(body.tiers.response).toMatchObject({ decided: 0, rate: null });
    expect(body.breakdowns.response).toHaveLength(13);
  });

  it("labels the user's applications and computes both tiers, never another user's", async () => {
    await seed(USER, 5, ["applied", "screening", "rejected"]); // response yes, interview no
    await seed(USER, 5, ["applied", "screening", "interviewing"]); // both yes
    await seed(USER, 60, ["applied"]); // idle: both no
    await seed(USER, 5, ["applied", "withdrawn"]); // excluded
    await seed(OTHER, 5, ["applied", "interviewing"], "other user");

    const body = await (await GET()).json();

    expect(body.totals).toEqual({ applications: 4, external: 4 });
    expect(body.tiers.response).toMatchObject({ decided: 3, positives: 2, negatives: 1, undecided: 0, excluded: 1 });
    expect(body.tiers.response.rate).toBeCloseTo(2 / 3, 6);
    expect(body.tiers.interview).toMatchObject({ decided: 3, positives: 1, negatives: 2, excluded: 1 });
    expect(JSON.stringify(body)).not.toMatch(/SECRET NOTE|other user/);
  });

  it("reports the response model: progress below the gate, then direction and strength per factor once active", async () => {
    const empty = await (await GET()).json();
    expect(empty.model).toEqual({
      status: "insufficient_data", decided: 0, responses: 0, nonResponses: 0, minDecided: 30, minPerClass: 8, blendWeight: null,
      looLogLoss: null, baselineLogLoss: null, factors: [],
    });

    await insertModelHistory(admin, USER, 40);
    const body = await (await GET()).json();
    expect(body.model).toMatchObject({ status: "active", decided: 40, responses: 20, nonResponses: 20, blendWeight: 0.2 });
    expect(body.model.looLogLoss).toBeLessThan(body.model.baselineLogLoss);
    expect(body.model.factors[0]).toMatchObject({ key: "skillsScore", label: "Skills", direction: "higher" });
    expect(body.model.factors[0].oddsRatio).toBeGreaterThan(1);
  });
});
