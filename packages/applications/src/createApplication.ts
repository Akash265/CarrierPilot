import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import { todayUtc, type CreateApplicationBody } from "./bodies";
import { buildFeatureSnapshot } from "./snapshot";
import { loadLinkedDocuments } from "./documentLinks";
import type { ApplicationRow } from "./types";

const { jobs, jobPostings, jobMatches, applications, applicationEvents } = schema;

/** Postgres unique_violation (23505), bare or wrapped as `cause` by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Phase 9 design §4.4. Builds the feature snapshot server-side (the client never sends one) and writes
 * the application plus its initial status_change event in one transaction. The partial unique index
 * (user_id, job_id) is the concurrency backstop for "one application per job" -> already_applied.
 */
export async function createApplication(
  db: DbClient,
  userId: string,
  body: CreateApplicationBody,
  now: Date = new Date()
): Promise<ApplicationRow> {
  const appliedAt = body.appliedAt ?? todayUtc(now);
  try {
    return await withUserContext(db, userId, async (tx) => {
      let values: Pick<ApplicationRow, "jobId" | "companyName" | "jobTitle" | "jobUrl" | "featureSnapshot" | "resumeOptimizationId" | "applicationPitchId" | "coverLetterId">;

      if (body.external) {
        values = {
          jobId: null,
          companyName: body.external.companyName,
          jobTitle: body.external.jobTitle,
          jobUrl: body.external.jobUrl ?? null,
          featureSnapshot: buildFeatureSnapshot({ kind: "external", companyName: body.external.companyName, jobTitle: body.external.jobTitle }),
          resumeOptimizationId: null,
          applicationPitchId: null,
          coverLetterId: null,
        };
      } else {
        const jobId = body.jobId!;
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
        if (!job) throw new ApplicationError("job_not_found");
        const docs = await loadLinkedDocuments(tx, jobId, body);
        const [match] = await tx.select().from(jobMatches).where(eq(jobMatches.jobId, jobId)).limit(1);
        const [posting] = await tx
          .select({ url: jobPostings.url })
          .from(jobPostings)
          .where(and(eq(jobPostings.jobId, jobId), isNotNull(jobPostings.url)))
          .orderBy(desc(jobPostings.lastSeenAt))
          .limit(1);
        values = {
          jobId,
          companyName: job.companyName,
          jobTitle: job.title,
          jobUrl: posting?.url ?? null,
          featureSnapshot: buildFeatureSnapshot({
            kind: "ingested",
            job,
            match: match ?? null,
            ats: docs.ats,
            documents: { resume: docs.resume, pitch: docs.pitch, coverLetter: docs.coverLetter },
            appliedAt,
          }),
          resumeOptimizationId: docs.resume?.id ?? null,
          applicationPitchId: docs.pitch?.id ?? null,
          coverLetterId: docs.coverLetter?.id ?? null,
        };
      }

      const [row] = await tx
        .insert(applications)
        .values({
          ...values,
          status: "applied",
          statusChangedAt: now,
          appliedAt,
          followUpAt: body.followUpAt ?? null,
          notes: body.notes || null,
          updatedAt: now,
        })
        .returning();
      await tx.insert(applicationEvents).values({
        applicationId: row.id, type: "status_change", occurredAt: now, fromStatus: null, toStatus: "applied", detail: {},
      });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApplicationError("already_applied");
    throw error;
  }
}
