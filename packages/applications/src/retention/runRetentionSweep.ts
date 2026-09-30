import { and, eq, isNotNull } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { isDueForPurge, planOrphanSweep, planRetention, type StoredObject } from "./planRetention";

const {
  applications, applicationEvents, generatedDocuments, resumeOptimizations, applicationPitches, coverLetters, interviewPreparations,
} = schema;

export interface RetentionStorage {
  listObjects(prefix: string): Promise<StoredObject[]>;
  removeObject(key: string): Promise<void>;
}

export interface RetentionSweepResult {
  status: "disabled" | "completed";
  purgedApplications: number;
  deletedRows: number;
  deletedObjects: number;
  orphanObjectsDeleted: number;
  failedObjectDeletes: number;
}

interface PurgeOutcome {
  objectKeys: string[];
  rowCount: number;
}

/**
 * One application, one transaction (design §4.5). FOR UPDATE SKIP LOCKED makes concurrent sweeps skip
 * each other's rows (no session advisory lock -- unreliable on a pooled connection). The due check is
 * repeated under the lock. Rows go first; objects are removed by the caller after commit, so a crash
 * can only leave objects without rows, which the orphan sweep collects.
 */
async function purgeOne(tx: DbClient, applicationId: string, now: Date, retentionDays: number): Promise<PurgeOutcome | null> {
  const [app] = await tx
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .for("update", { skipLocked: true });
  if (!app || !isDueForPurge(app, now, retentionDays)) return null;
  const jobId = app.jobId!;

  const docs = await tx.delete(generatedDocuments).where(eq(generatedDocuments.jobId, jobId)).returning({ objectKey: generatedDocuments.objectKey });
  const resumes = await tx.delete(resumeOptimizations).where(eq(resumeOptimizations.jobId, jobId)).returning({ id: resumeOptimizations.id });
  const pitches = await tx.delete(applicationPitches).where(eq(applicationPitches.jobId, jobId)).returning({ id: applicationPitches.id });
  const letters = await tx.delete(coverLetters).where(eq(coverLetters.jobId, jobId)).returning({ id: coverLetters.id });
  const preps = await tx.delete(interviewPreparations).where(eq(interviewPreparations.jobId, jobId)).returning({ id: interviewPreparations.id });

  const counts = {
    generatedDocuments: docs.length,
    resumeOptimizations: resumes.length,
    applicationPitches: pitches.length,
    coverLetters: letters.length,
    interviewPreparations: preps.length,
  };
  await tx.update(applications).set({ retentionPurgedAt: now, updatedAt: now }).where(eq(applications.id, applicationId));
  await tx.insert(applicationEvents).values({ applicationId, type: "documents_purged", occurredAt: now, detail: counts });

  return { objectKeys: docs.map((d) => d.objectKey), rowCount: Object.values(counts).reduce((a, b) => a + b, 0) };
}

export async function runRetentionSweep(opts: {
  db: DbClient;
  storage: RetentionStorage;
  userId: string;
  retentionDays: number;
  now?: Date;
}): Promise<RetentionSweepResult> {
  const { db, storage, userId, retentionDays } = opts;
  const now = opts.now ?? new Date();
  const result: RetentionSweepResult = {
    status: "completed", purgedApplications: 0, deletedRows: 0, deletedObjects: 0, orphanObjectsDeleted: 0, failedObjectDeletes: 0,
  };
  if (retentionDays <= 0) return { ...result, status: "disabled" };

  const removeAll = async (keys: string[], counter: "deletedObjects" | "orphanObjectsDeleted") => {
    for (const key of keys) {
      try {
        await storage.removeObject(key);
        result[counter]++;
      } catch {
        result.failedObjectDeletes++;
      }
    }
  };

  const candidates = await withUserContext(db, userId, (tx) =>
    tx
      .select({ id: applications.id, jobId: applications.jobId, terminalAt: applications.terminalAt, retentionPurgedAt: applications.retentionPurgedAt })
      .from(applications)
      .where(and(isNotNull(applications.jobId), isNotNull(applications.terminalAt)))
  );

  for (const candidate of planRetention({ candidates, now, retentionDays })) {
    const outcome = await withUserContext(db, userId, (tx) => purgeOne(tx, candidate.id, now, retentionDays));
    if (!outcome) continue;
    result.purgedApplications++;
    result.deletedRows += outcome.rowCount;
    await removeAll(outcome.objectKeys, "deletedObjects");
  }

  const objects = await storage.listObjects(`${userId}/`);
  if (objects.length > 0) {
    const referenced = await withUserContext(db, userId, (tx) => tx.select({ key: generatedDocuments.objectKey }).from(generatedDocuments));
    await removeAll(planOrphanSweep({ objects, referencedKeys: new Set(referenced.map((r) => r.key)), now }), "orphanObjectsDeleted");
  }

  return result;
}
