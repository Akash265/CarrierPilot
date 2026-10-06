import { asc, eq, inArray } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { InsightEventType, InsightInputs } from "../types";

const { applications, applicationEvents, careerGoals, careerGoalConstraints } = schema;
const ACTIVITY_TYPES: InsightEventType[] = ["status_change", "recruiter_contact", "interview"];

/**
 * Spec §3. Everything the dataset needs, in one transaction under repeatable read so the three reads are one
 * consistent view. Selects only the columns the dataset uses: never notes, recruiter fields, salary notes,
 * the job URL or event details (spec §8).
 */
export async function loadInsightInputs(db: DbClient, userId: string): Promise<InsightInputs> {
  return withUserContext(
    db,
    userId,
    async (tx) => {
      const applicationRows = await tx
        .select({
          id: applications.id, jobId: applications.jobId, companyName: applications.companyName, jobTitle: applications.jobTitle,
          status: applications.status, appliedAt: applications.appliedAt, createdAt: applications.createdAt,
          featureSnapshot: applications.featureSnapshot,
        })
        .from(applications);
      const eventRows = await tx
        .select({
          applicationId: applicationEvents.applicationId, type: applicationEvents.type, occurredAt: applicationEvents.occurredAt,
          toStatus: applicationEvents.toStatus,
        })
        .from(applicationEvents)
        .where(inArray(applicationEvents.type, ACTIVITY_TYPES))
        .orderBy(asc(applicationEvents.occurredAt), asc(applicationEvents.createdAt));
      const goalRows = await tx
        .select({
          id: careerGoals.id, confirmedAt: careerGoals.confirmedAt, targetRoles: careerGoalConstraints.targetRoles,
          salaryFloorNormalized: careerGoalConstraints.salaryFloorNormalized, salaryCurrency: careerGoalConstraints.salaryCurrency,
          salaryIsParsed: careerGoalConstraints.salaryIsParsed,
        })
        .from(careerGoals)
        .innerJoin(careerGoalConstraints, eq(careerGoalConstraints.careerGoalId, careerGoals.id))
        .where(eq(careerGoals.confirmationStatus, "confirmed"));

      return {
        applications: applicationRows,
        events: eventRows.map((e) => ({ ...e, type: e.type as InsightEventType })),
        goals: goalRows.map((g) => ({
          ...g,
          salaryFloorNormalized: g.salaryFloorNormalized === null ? null : Number(g.salaryFloorNormalized),
        })),
      };
    },
    { isolationLevel: "repeatable read" }
  );
}
