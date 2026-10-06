import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, type TestDb } from "@ai-career/applications/testing";
import { createApplication } from "@ai-career/applications";
import { loadInsightInputs } from "./loadInsightInputs";
import { buildOutcomeDataset } from "../dataset/buildOutcomeDataset";

const USER = "00000000-0000-0000-0000-000000000a01";
const OTHER = "00000000-0000-0000-0000-000000000a02";
const BACKDATED_USER = "00000000-0000-0000-0000-000000000a05";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
  await wipeUser(t.adminSql, BACKDATED_USER);
  await t.close();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
  await wipeUser(t.adminSql, BACKDATED_USER);
});

async function seedApplication(userId: string, notes: string): Promise<string> {
  const [row] = await t.adminSql`
    INSERT INTO applications (user_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot, notes,
                              recruiter_name, salary_notes)
    VALUES (${userId}, 'Acme', 'Data Engineer', 'screening', now(), '2026-10-01', '{"snapshotVersion":2,"external":true}'::jsonb,
            ${notes}, 'Sam Recruiter', 'asked for 90k')
    RETURNING id`;
  const id = row.id as string;
  await t.adminSql`
    INSERT INTO application_events (user_id, application_id, type, occurred_at, from_status, to_status, detail) VALUES
      (${userId}, ${id}, 'status_change', '2026-10-01T09:00:00Z', null, 'applied', '{}'::jsonb),
      (${userId}, ${id}, 'status_change', '2026-10-03T09:00:00Z', 'applied', 'screening', '{}'::jsonb),
      (${userId}, ${id}, 'note', '2026-10-04T09:00:00Z', null, null, '{"text":"private"}'::jsonb),
      (${userId}, ${id}, 'recruiter_contact', '2026-10-05T09:00:00Z', null, null, '{"channel":"email","summary":"x"}'::jsonb)`;
  return id;
}

async function seedGoal(userId: string, opts: { confirmed: boolean; roles: string[]; floor: string | null }): Promise<string> {
  const [goal] = await t.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active, confirmed_at)
    VALUES (${userId}, 'goal', ${opts.confirmed ? 1 : 2}, 'parsed', ${opts.confirmed ? "confirmed" : "draft"}, ${opts.confirmed},
            ${opts.confirmed ? "2026-09-01T00:00:00Z" : null}::timestamptz)
    RETURNING id`;
  await t.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, work_mode, salary_floor_normalized, salary_currency, salary_is_parsed)
    VALUES (${userId}, ${goal.id}, ${opts.roles}, 'any', ${opts.floor}, ${opts.floor ? "EUR" : null}, ${opts.floor !== null})`;
  return goal.id as string;
}

describe("loadInsightInputs", () => {
  it("reads the user's applications, activity events and confirmed goals -- nothing else", async () => {
    const id = await seedApplication(USER, "SECRET NOTE");
    const goalId = await seedGoal(USER, { confirmed: true, roles: ["Data Engineer"], floor: "80000" });
    await seedGoal(USER, { confirmed: false, roles: ["Draft Role"], floor: null });

    const inputs = await loadInsightInputs(t.db, USER);

    expect(inputs.applications).toEqual([{
      id, jobId: null, companyName: "Acme", jobTitle: "Data Engineer", status: "screening", appliedAt: "2026-10-01",
      createdAt: expect.any(Date), featureSnapshot: { snapshotVersion: 2, external: true },
    }]);
    expect(inputs.events.map((e) => [e.type, e.fromStatus, e.toStatus, e.occurredAt.toISOString()])).toEqual([
      ["status_change", null, "applied", "2026-10-01T09:00:00.000Z"],
      ["status_change", "applied", "screening", "2026-10-03T09:00:00.000Z"],
      ["recruiter_contact", null, null, "2026-10-05T09:00:00.000Z"],
    ]);
    expect(inputs.goals).toEqual([{
      id: goalId, confirmedAt: new Date("2026-09-01T00:00:00Z"), targetRoles: ["Data Engineer"], salaryFloorNormalized: 80000,
      salaryCurrency: "EUR", salaryIsParsed: true,
    }]);
    expect(JSON.stringify(inputs)).not.toMatch(/SECRET NOTE|Sam Recruiter|asked for 90k|private/);
  });

  it("never returns another user's rows (RLS)", async () => {
    await seedApplication(OTHER, "theirs");
    await seedGoal(OTHER, { confirmed: true, roles: ["Other Role"], floor: null });
    expect(await loadInsightInputs(t.db, USER)).toEqual({ applications: [], events: [], goals: [] });
  });

  it("does not treat a backdated application's creation event as recent activity (real write path)", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const appliedAt = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
    await createApplication(t.db, BACKDATED_USER, { external: { companyName: "Acme", jobTitle: "Data Engineer" }, appliedAt }, now);

    const inputs = await loadInsightInputs(t.db, BACKDATED_USER);
    const [record] = buildOutcomeDataset(inputs, { now, undecidedDays: 30 });
    expect(record.response.label).toBe("negative");
  });
});
