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

  it("stores no jobUrl when the ingested posting's url is not http(s) (untrusted job-source content)", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await t.adminSql`UPDATE job_postings SET url = 'javascript:alert(1)' WHERE job_id = ${s.jobId}`;
    const row = await createApplication(t.db, USER, { jobId: s.jobId }, NOW);
    expect(row.jobUrl).toBeNull();
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

  async function seedSession(jobId: string, status: string, docs: { resumeOptimizationId?: string; coverLetterId?: string } = {}) {
    const doc = async (kind: "resume" | "cover_letter", sourceId: string | undefined) => {
      if (!sourceId) return null;
      const [row] = await t.adminSql`
        INSERT INTO generated_documents (user_id, job_id, kind, format, resume_optimization_id, cover_letter_id, object_key, byte_size,
                                         content_hash, renderer_version, download_filename)
        VALUES (${USER}, ${jobId}, ${kind}, 'pdf', ${kind === "resume" ? sourceId : null}, ${kind === "cover_letter" ? sourceId : null},
                ${`${USER}/${kind}.pdf`}, 10, ${"h-" + kind}, 'r1', ${kind + ".pdf"})
        RETURNING id`;
      return row.id as string;
    };
    const terminal = ["submission_detected", "abandoned", "needs_manual", "failed"].includes(status);
    const [row] = await t.adminSql`
      INSERT INTO automation_sessions (user_id, job_id, portal, adapter_version, form_url, status, ended_at, resume_document_id, cover_letter_document_id)
      VALUES (${USER}, ${jobId}, 'greenhouse', 'greenhouse-v1', 'https://job-boards.greenhouse.io/acme/jobs/1', ${status},
              ${terminal ? NOW.toISOString() : null}::timestamptz, ${await doc("resume", docs.resumeOptimizationId)},
              ${await doc("cover_letter", docs.coverLetterId)})
      RETURNING id`;
    return row.id as string;
  }

  it("links a detected-submission session and defaults the documents to the files it attached", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const sessionId = await seedSession(s.jobId, "submission_detected", { resumeOptimizationId: s.resumeId, coverLetterId: s.coverLetterId });
    const row = await createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: sessionId }, NOW);
    expect(row).toMatchObject({ resumeOptimizationId: s.resumeId, coverLetterId: s.coverLetterId, applicationPitchId: null });
    const [session] = await t.adminSql`SELECT application_id FROM automation_sessions WHERE id = ${sessionId}`;
    expect(session.application_id).toBe(row.id);
  });

  it("lets explicit body ids win over the session's attachments", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const sessionId = await seedSession(s.jobId, "abandoned", { resumeOptimizationId: s.resumeId });
    const row = await createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: sessionId, resumeOptimizationId: null }, NOW);
    expect(row.resumeOptimizationId).toBeNull();
  });

  it("rejects a session that is active, already linked, for another job or unknown", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const active = await seedSession(s.jobId, "awaiting_user");
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: active }, NOW))).toBe("session_not_linkable");
    const other = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    const otherJobSession = await seedSession(other.jobId, "abandoned");
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: otherJobSession }, NOW))).toBe("session_not_linkable");
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: s.jobId, automationSessionId: "11111111-1111-4111-8111-111111111111" }, NOW))).toBe("session_not_linkable");
    const done = await seedSession(other.jobId, "submission_detected");
    await createApplication(t.db, USER, { jobId: other.jobId, automationSessionId: done }, NOW);
    // Free the job for the "already linked" case (deleting the application SET NULLs `done`'s link).
    await t.adminSql`DELETE FROM applications WHERE job_id = ${other.jobId}`;
    const linked = await seedSession(other.jobId, "abandoned");
    const [app] = await t.adminSql`
      INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot)
      VALUES (${USER}, null, 'Elsewhere', 'Role', 'applied', now(), current_date, '{}'::jsonb) RETURNING id`;
    await t.adminSql`UPDATE automation_sessions SET application_id = ${app.id} WHERE id = ${linked}`;
    expect(await errorClassOf(createApplication(t.db, USER, { jobId: other.jobId, automationSessionId: linked }, NOW))).toBe("session_not_linkable");
    expect(await t.adminSql`SELECT 1 FROM applications WHERE job_id = ${other.jobId}`).toHaveLength(0);
    expect(await t.adminSql`SELECT 1 FROM applications WHERE job_id = ${s.jobId}`).toHaveLength(0);
  });
});
