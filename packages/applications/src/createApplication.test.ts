import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "./testing";
import { createApplication } from "./createApplication";
import { ApplicationError } from "./errors";

const USER = "00000000-0000-0000-0000-0000000009a1";
const NOW = new Date("2026-09-30T10:00:00Z");
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

const errorClassOf = (p: Promise<unknown>) =>
  p.then(() => "resolved", (e) => (e instanceof ApplicationError ? e.errorClass : `other:${String(e)}`));

describe("createApplication", () => {
  it("creates an ingested application with copied job fields, links, snapshot and an initial status event", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const row = await createApplication(t.db, USER, { jobId: s.jobId, resumeOptimizationId: s.resumeId, applicationPitchId: s.pitchId }, NOW);

    expect(row).toMatchObject({
      jobId: s.jobId, companyName: "Acme", jobTitle: "Data Engineer", jobUrl: "https://jobs.example/1", status: "applied",
      appliedAt: "2026-09-30", resumeOptimizationId: s.resumeId, applicationPitchId: s.pitchId, coverLetterId: null, terminalAt: null,
    });
    const snap = row.featureSnapshot as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- deep dynamic snapshot shape, checked below field by field
    expect(snap.external).toBe(false);
    expect(snap.match).toMatchObject({ careerGoalId: s.goalId, overallScore: 78 });
    expect(snap.ats).toMatchObject({ overallScore: 82, requiredKeywordCoverage: 0.9 });
    expect(snap.documents.resume).toMatchObject({ id: s.resumeId, version: 1, sourceProfileContentHash: "profile-hash" });
    expect(snap.documents.pitch).toMatchObject({ id: s.pitchId, version: 1, origin: "generated" });
    expect(snap.job.postingAgeDays).toBe(10);

    const events = await t.adminSql`SELECT type, from_status, to_status FROM application_events WHERE application_id = ${row.id}`;
    expect(events).toEqual([{ type: "status_change", from_status: null, to_status: "applied" }]);
  });

  it("creates an external application with no job, typed-in fields and an external snapshot", async () => {
    const row = await createApplication(t.db, USER, { external: { companyName: "Globex", jobTitle: "Analyst", jobUrl: null }, appliedAt: "2026-09-28" }, NOW);
    expect(row).toMatchObject({ jobId: null, companyName: "Globex", jobTitle: "Analyst", appliedAt: "2026-09-28" });
    expect((row.featureSnapshot as { external: boolean }).external).toBe(true);
  });

  it("returns job_not_found for an unknown job", async () => {
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: "11111111-1111-4111-8111-111111111111" }, NOW))).toBe("job_not_found");
  });

  it("returns already_applied for a second application to the same job, and writes nothing", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await createApplication(t.db, USER, { jobId: s.jobId }, NOW);
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId }, NOW))).toBe("already_applied");
    const [{ n }] = await t.adminSql`SELECT count(*)::int AS n FROM application_events WHERE user_id = ${USER}`;
    expect(n).toBe(1);
  });

  it("returns document_mismatch when a linked document belongs to another job", async () => {
    const a = await seedJobWithDocuments(t.adminSql, USER, { title: "Data Engineer" });
    const b = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: a.jobId, coverLetterId: b.coverLetterId }, NOW))).toBe("document_mismatch");
  });

  it("cannot see another user's job", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    expect(await errorClassOf(createApplication(t.db, "00000000-0000-0000-0000-0000000009a2", { jobId: s.jobId }, NOW))).toBe("job_not_found");
  });
});
