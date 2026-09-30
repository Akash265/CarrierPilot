import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "../testing";
import { createApplication } from "../createApplication";
import { runRetentionSweep, type RetentionStorage } from "./runRetentionSweep";
import type { StoredObject } from "./planRetention";

const USER = "00000000-0000-0000-0000-0000000009a5";
const NOW = new Date("2026-11-15T00:00:00Z");
const DAY = 86_400_000;
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

/** In-memory storage: records removals; keys listed in `failKeys` throw on remove. */
function fakeStorage(objects: StoredObject[] = [], failKeys: string[] = []) {
  const removed: string[] = [];
  const storage: RetentionStorage = {
    listObjects: async (prefix) => objects.filter((o) => o.key.startsWith(prefix) && !removed.includes(o.key)),
    removeObject: async (key) => {
      if (failKeys.includes(key)) throw new Error("boom");
      removed.push(key);
    },
  };
  return { storage, removed };
}

async function addDocument(jobId: string, key: string, sourceColumn: "resume_optimization_id" | "cover_letter_id", sourceId: string, kind: string) {
  await t.adminSql.unsafe(
    `INSERT INTO generated_documents (user_id, job_id, kind, format, ${sourceColumn}, object_key, byte_size, content_hash, renderer_version, download_filename)
     VALUES ($1, $2, $3, 'pdf', $4, $5, 10, $6, 'r1', 'f.pdf')`,
    [USER, jobId, kind, sourceId, key, `hash-${key}`]
  );
}

async function terminalApplication(jobId: string, terminalDaysAgo: number) {
  const app = await createApplication(t.db, USER, { jobId });
  // .toISOString() + explicit ::timestamptz cast, not a raw Date: passing a JS Date object directly as an
  // adminSql tagged-template parameter throws ("received an instance of Date") once this connection has run
  // drizzle's migrate() -- same workaround already used in packages/db/src/applicationTables.rls.test.ts.
  await t.adminSql`UPDATE applications SET status = 'rejected', terminal_at = ${new Date(NOW.getTime() - terminalDaysAgo * DAY).toISOString()}::timestamptz WHERE id = ${app.id}`;
  return app;
}

const countFor = async (table: string, jobId: string) =>
  (await t.adminSql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE job_id = $1`, [jobId]))[0].n as number;

describe("runRetentionSweep", () => {
  it("does nothing when disabled", async () => {
    const { storage, removed } = fakeStorage([{ key: `${USER}/x.pdf`, lastModified: new Date(0) }]);
    const r = await runRetentionSweep({ db: t.db, storage, userId: USER, retentionDays: 0, now: NOW });
    expect(r.status).toBe("disabled");
    expect(removed).toEqual([]);
  });

  it("purges exactly the due job's rows and objects, keeps another job's, and records it", async () => {
    const due = await seedJobWithDocuments(t.adminSql, USER, { title: "Data Engineer" });
    const kept = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    await addDocument(due.jobId, `${USER}/due-resume.pdf`, "resume_optimization_id", due.resumeId, "resume");
    await addDocument(due.jobId, `${USER}/due-letter.pdf`, "cover_letter_id", due.coverLetterId, "cover_letter");
    await addDocument(kept.jobId, `${USER}/kept.pdf`, "resume_optimization_id", kept.resumeId, "resume");
    const app = await terminalApplication(due.jobId, 31);
    await terminalApplication(kept.jobId, 5);

    const { storage, removed } = fakeStorage();
    const r = await runRetentionSweep({ db: t.db, storage, userId: USER, retentionDays: 30, now: NOW });

    expect(r).toMatchObject({ status: "completed", purgedApplications: 1, deletedObjects: 2, failedObjectDeletes: 0 });
    expect(removed.sort()).toEqual([`${USER}/due-letter.pdf`, `${USER}/due-resume.pdf`]);
    for (const table of ["generated_documents", "resume_optimizations", "application_pitches", "cover_letters", "interview_preparations"]) {
      expect(await countFor(table, due.jobId), table).toBe(0);
      expect(await countFor(table, kept.jobId), table).toBeGreaterThan(0);
    }
    const [row] = await t.adminSql`SELECT retention_purged_at, resume_optimization_id, feature_snapshot FROM applications WHERE id = ${app.id}`;
    // This adminSql connection has run drizzle's migrate() (see openTestDb), which leaves its timestamptz
    // result parsing returning a raw Postgres string instead of a parsed Date -- wrap it explicitly.
    expect(new Date(row.retention_purged_at as string)).toEqual(NOW);
    expect(row.feature_snapshot.match.overallScore).toBe(78);
    const [event] = await t.adminSql`SELECT detail FROM application_events WHERE application_id = ${app.id} AND type = 'documents_purged'`;
    expect(event.detail).toEqual({ generatedDocuments: 2, resumeOptimizations: 1, applicationPitches: 1, coverLetters: 1, interviewPreparations: 1 });
  });

  it("does not purge the same application twice", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await terminalApplication(s.jobId, 31);
    await runRetentionSweep({ db: t.db, storage: fakeStorage().storage, userId: USER, retentionDays: 30, now: NOW });
    const second = await runRetentionSweep({ db: t.db, storage: fakeStorage().storage, userId: USER, retentionDays: 30, now: NOW });
    expect(second.purgedApplications).toBe(0);
  });

  it("skips an application row locked by another transaction", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    const app = await terminalApplication(s.jobId, 31);
    const locker = await t.adminSql.reserve();
    try {
      await locker`BEGIN`;
      await locker`SELECT id FROM applications WHERE id = ${app.id} FOR UPDATE`;
      const r = await runRetentionSweep({ db: t.db, storage: fakeStorage().storage, userId: USER, retentionDays: 30, now: NOW });
      expect(r.purgedApplications).toBe(0);
    } finally {
      await locker`ROLLBACK`;
      locker.release();
    }
    expect(await countFor("resume_optimizations", s.jobId)).toBe(1);
  });

  it("counts a failed object removal and leaves the object for the orphan sweep", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await addDocument(s.jobId, `${USER}/stuck.pdf`, "resume_optimization_id", s.resumeId, "resume");
    await terminalApplication(s.jobId, 31);
    const r = await runRetentionSweep({ db: t.db, storage: fakeStorage([], [`${USER}/stuck.pdf`]).storage, userId: USER, retentionDays: 30, now: NOW });
    expect(r).toMatchObject({ purgedApplications: 1, deletedObjects: 0, failedObjectDeletes: 1 });
  });

  it("orphan sweep removes unreferenced objects older than 24h and keeps referenced or recent ones", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    await addDocument(s.jobId, `${USER}/referenced.pdf`, "resume_optimization_id", s.resumeId, "resume");
    const { storage, removed } = fakeStorage([
      { key: `${USER}/referenced.pdf`, lastModified: new Date(NOW.getTime() - 5 * DAY) },
      { key: `${USER}/orphan-old.pdf`, lastModified: new Date(NOW.getTime() - 2 * DAY) },
      { key: `${USER}/orphan-new.pdf`, lastModified: new Date(NOW.getTime() - 60_000) },
    ]);
    const r = await runRetentionSweep({ db: t.db, storage, userId: USER, retentionDays: 30, now: NOW });
    expect(removed).toEqual([`${USER}/orphan-old.pdf`]);
    expect(r.orphanObjectsDeleted).toBe(1);
  });
});
