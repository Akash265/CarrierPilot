import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type DbClient } from "@ai-career/db";
import { blendedScore, predictResponse, type ResponseModel, type ResponsePrediction } from "@ai-career/insights";
import { factorVectorOf, toMatchView, type MatchView } from "./serializeMatch";

const { jobMatches, jobs } = schema;

export const PAGE_SIZE = 25;

export const ListMatchesQuerySchema = z.object({
  eligible: z.enum(["true", "false"]).default("true"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  /** Phase 10b: "personal" re-sorts the eligible list by the blended score when the response model is active. */
  rank: z.enum(["default", "personal"]).default("default"),
});
export type ListMatchesQuery = z.infer<typeof ListMatchesQuerySchema>;

export interface MatchListItem {
  jobId: string;
  jobTitle: string;
  companyName: string;
  locationRaw: string | null;
  workMode: (typeof jobs.$inferSelect)["workMode"];
  match: MatchView;
}

/** The active response model (or null) and its blend weight, from loadResponseModel. */
export interface PersonalRanking {
  model: ResponseModel | null;
  weight: number | null;
}

export interface MatchListResult {
  matches: MatchListItem[];
  page: number;
  pageSize: number;
  total: number;
  /** The order actually used -- "personal" only when it was requested, the list is eligible and the model is active. */
  ranking: "default" | "personal";
}

export async function listMatches(
  tx: DbClient,
  query: ListMatchesQuery,
  personal: PersonalRanking = { model: null, weight: null }
): Promise<MatchListResult> {
  const eligible = query.eligible === "true";
  // A job can close between matching runs; runMatching then marks its row ineligible ("posting has closed"),
  // but until that next run the eligible list must not offer a job that can no longer be applied to.
  const where = eligible ? and(eq(jobMatches.eligible, true), eq(jobs.status, "open")) : eq(jobMatches.eligible, false);

  const baseQuery = () =>
    tx
      .select({
        id: jobMatches.id,
        jobId: jobMatches.jobId,
        eligible: jobMatches.eligible,
        ineligibleReason: jobMatches.ineligibleReason,
        skillsScore: jobMatches.skillsScore,
        experienceScore: jobMatches.experienceScore,
        locationScore: jobMatches.locationScore,
        sponsorshipScore: jobMatches.sponsorshipScore,
        roleScore: jobMatches.roleScore,
        salaryScore: jobMatches.salaryScore,
        industryScore: jobMatches.industryScore,
        freshnessScore: jobMatches.freshnessScore,
        semanticScore: jobMatches.semanticScore,
        overallScore: jobMatches.overallScore,
        explanation: jobMatches.explanation,
        explanationModel: jobMatches.explanationModel,
        explanationDescriptionHash: jobMatches.explanationDescriptionHash,
        explanationGeneratedAt: jobMatches.explanationGeneratedAt,
        userAction: jobMatches.userAction,
        userActionAt: jobMatches.userActionAt,
        computedAt: jobMatches.computedAt,
        createdAt: jobMatches.createdAt,
        userId: jobMatches.userId,
        careerGoalId: jobMatches.careerGoalId,
        jobTitle: jobs.title,
        companyName: jobs.companyName,
        locationRaw: jobs.locationRaw,
        workMode: jobs.workMode,
      })
      .from(jobMatches)
      .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
      .where(where);
  type Row = Awaited<ReturnType<typeof baseQuery>>[number];

  const { model, weight } = personal;
  const predict = (row: Row): ResponsePrediction | null =>
    model !== null && row.eligible ? predictResponse(model, factorVectorOf(row)) : null;
  const toItem = (row: Row, prediction: ResponsePrediction | null): MatchListItem => ({
    jobId: row.jobId,
    jobTitle: row.jobTitle,
    companyName: row.companyName,
    locationRaw: row.locationRaw,
    workMode: row.workMode,
    match: toMatchView(row, prediction),
  });

  if (eligible && query.rank === "personal" && model !== null && weight !== null) {
    // Phase 10b spec §4.6: blended score desc, then overall score desc, then job id; paged in code.
    const rows = await baseQuery();
    const ranked = rows
      .map((row) => {
        const prediction = predict(row)!;
        const overall = Number(row.overallScore ?? 0);
        return { row, prediction, overall, blended: blendedScore(overall, prediction.probability, weight) };
      })
      .sort((a, b) => b.blended - a.blended || b.overall - a.overall || a.row.jobId.localeCompare(b.row.jobId));
    const start = (query.page - 1) * PAGE_SIZE;
    return {
      matches: ranked.slice(start, start + PAGE_SIZE).map((r) => toItem(r.row, r.prediction)),
      page: query.page,
      pageSize: PAGE_SIZE,
      total: rows.length,
      ranking: "personal",
    };
  }

  const rows = await baseQuery()
    .orderBy(eligible ? sql`${jobMatches.overallScore} DESC NULLS LAST` : desc(jobMatches.computedAt), jobMatches.id)
    .limit(PAGE_SIZE)
    .offset((query.page - 1) * PAGE_SIZE);
  const [{ total }] = await tx.select({ total: count() }).from(jobMatches).innerJoin(jobs, eq(jobs.id, jobMatches.jobId)).where(where);

  return {
    matches: rows.map((row) => toItem(row, predict(row))),
    page: query.page,
    pageSize: PAGE_SIZE,
    total,
    ranking: "default",
  };
}
