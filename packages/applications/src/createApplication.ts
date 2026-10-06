import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { ApplicationError } from "./errors";
import { todayUtc, type CreateApplicationBody } from "./bodies";
import { buildFeatureSnapshot } from "./snapshot";
import { loadLinkedDocuments } from "./documentLinks";
import { findMissedTerms, joinOptimizedText } from "./missedTerms";
import { lockLinkableSession, withSessionDocuments, type LinkableSession } from "./sessionLink";
import type { ApplicationRow } from "./types";

const { jobs, jobPostings, jobMatches, applications, applicationEvents, automationSessions, resumeOptimizations, jobRequirements } = schema;

const HTTP_URL_RE = /^https?:\/\//i;
/** Ingested posting URLs are untrusted (job-source content); only http(s) is safe to store/render as a link. */
const safeHttpUrl = (url: string | null | undefined): string | null => (url && HTTP_URL_RE.test(url) ? url : null);

/** Postgres unique_violation (23505), bare or wrapped as `cause` by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Phase 9 design §4.4. Builds the feature snapshot server-side (the client never sends one) and writes
 * the application plus its initial status_change event in one transaction. The partial unique index
 * (user_id, job_id) is the concurrency backstop for "one application per job" -> already_applied.
 * With automationSessionId (Phase 8), the session is locked, validated and linked in the same transaction.
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
      let session: LinkableSession | null = null;

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
        if (body.automationSessionId) session = await lockLinkableSession(tx, body.automationSessionId, jobId);
        const docs = await loadLinkedDocuments(tx, jobId, session ? await withSessionDocuments(tx, session, body) : body);
        // Phase 10a snapshot v2: which required terms the resume actually sent did not contain (spec §6).
        let missedRequiredTerms: string[] | null = null;
        if (docs.resume) {
          const [optimization] = await tx
            .select({ bullets: resumeOptimizations.selectedBullets })
            .from(resumeOptimizations)
            .where(eq(resumeOptimizations.id, docs.resume.id));
          const required = await tx
            .select({ termText: jobRequirements.termText })
            .from(jobRequirements)
            .where(and(eq(jobRequirements.jobId, jobId), eq(jobRequirements.requirementLevel, "required")))
            .orderBy(asc(jobRequirements.createdAt), asc(jobRequirements.id));
          missedRequiredTerms = findMissedTerms(required.map((r) => r.termText), joinOptimizedText(optimization?.bullets));
        }
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
          jobUrl: safeHttpUrl(posting?.url),
          featureSnapshot: buildFeatureSnapshot({
            kind: "ingested",
            job,
            match: match ?? null,
            ats: docs.ats,
            documents: { resume: docs.resume, pitch: docs.pitch, coverLetter: docs.coverLetter },
            appliedAt,
            missedRequiredTerms,
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
      if (session) {
        await tx.update(automationSessions).set({ applicationId: row.id, updatedAt: now }).where(eq(automationSessions.id, session.id));
      }
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApplicationError("already_applied");
    throw error;
  }
}
