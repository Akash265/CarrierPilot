import { and, asc, count, desc, eq, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { ApplicationEventRow, ApplicationRow, ApplicationStatus } from "./types";

const { applications, applicationEvents, resumeOptimizations, applicationPitches, coverLetters } = schema;

export interface DocumentOption {
  id: string;
  version: number;
  origin: "generated" | "user_edited" | null;
}
export interface DocumentOptions {
  resumes: DocumentOption[];
  pitches: DocumentOption[];
  coverLetters: DocumentOption[];
}

/** A follow-up is due when its date is today or earlier and the application is still open. */
const dueCondition = (today: string): SQL =>
  and(isNotNull(applications.followUpAt), lte(applications.followUpAt, today), isNull(applications.terminalAt))!;

export async function getApplication(
  db: DbClient,
  userId: string,
  id: string
): Promise<{ application: ApplicationRow; events: ApplicationEventRow[] } | null> {
  return withUserContext(db, userId, async (tx) => {
    const [application] = await tx.select().from(applications).where(eq(applications.id, id)).limit(1);
    if (!application) return null;
    const events = await tx
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.applicationId, id))
      .orderBy(asc(applicationEvents.occurredAt), asc(applicationEvents.createdAt));
    return { application, events };
  });
}

export async function listApplications(
  db: DbClient,
  userId: string,
  opts: { status?: ApplicationStatus; dueOnly?: boolean; today: string }
): Promise<{ applications: ApplicationRow[]; dueCount: number }> {
  return withUserContext(db, userId, async (tx) => {
    const filters: SQL[] = [];
    if (opts.status) filters.push(eq(applications.status, opts.status));
    if (opts.dueOnly) filters.push(dueCondition(opts.today));
    const rows = await tx
      .select()
      .from(applications)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(applications.appliedAt), desc(applications.createdAt));
    const [{ n }] = await tx.select({ n: count() }).from(applications).where(dueCondition(opts.today));
    return { applications: rows, dueCount: n };
  });
}

export async function getApplicationForJob(db: DbClient, userId: string, jobId: string): Promise<ApplicationRow | null> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx.select().from(applications).where(eq(applications.jobId, jobId)).limit(1);
    return row ?? null;
  });
}

/** The versions the "Mark as applied" panel offers, newest first. */
export async function listDocumentOptions(db: DbClient, userId: string, jobId: string): Promise<DocumentOptions> {
  return withUserContext(db, userId, async (tx) => {
    const resumes = await tx
      .select({ id: resumeOptimizations.id, version: resumeOptimizations.version })
      .from(resumeOptimizations)
      .where(eq(resumeOptimizations.jobId, jobId))
      .orderBy(desc(resumeOptimizations.version));
    const pitches = await tx
      .select({ id: applicationPitches.id, version: applicationPitches.version, origin: applicationPitches.origin })
      .from(applicationPitches)
      .where(eq(applicationPitches.jobId, jobId))
      .orderBy(desc(applicationPitches.version));
    const letters = await tx
      .select({ id: coverLetters.id, version: coverLetters.version, origin: coverLetters.origin })
      .from(coverLetters)
      .where(eq(coverLetters.jobId, jobId))
      .orderBy(desc(coverLetters.version));
    return { resumes: resumes.map((r) => ({ ...r, origin: null })), pitches, coverLetters: letters };
  });
}
