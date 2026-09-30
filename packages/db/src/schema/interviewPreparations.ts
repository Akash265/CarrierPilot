import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { companyResearch, companyResearchStatusEnum } from "./companyResearch";

/**
 * Phase 7c design §3. One read-only, generated version per row (no user_edited origin); version
 * increments per (user_id, job_id) under an advisory lock (insertInterviewPrepVersion).
 * sections: StoredInterviewPrepSections { likelyQuestions, gapQuestions, talkingPoints, questionsToAsk },
 * each item carrying supported / unsupportedReason / evidence snapshots. gapTermsSnapshot: string[] --
 * the deterministic missing required terms (computeGapTerms) the pack was generated from.
 */
export const interviewPreparations = pgTable(
  "interview_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    companyResearchId: uuid("company_research_id").references(() => companyResearch.id, { onDelete: "set null" }),
    researchStatusSnapshot: companyResearchStatusEnum("research_status_snapshot").notNull(),
    researchedAtSnapshot: timestamp("researched_at_snapshot", { withTimezone: true }),
    sections: jsonb("sections").notNull(),
    gapTermsSnapshot: jsonb("gap_terms_snapshot").notNull(),
    requiresReview: boolean("requires_review").notNull(),
    sourceProfileContentHash: text("source_profile_content_hash").notNull(),
    generationModel: text("generation_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobVersionUniq: uniqueIndex("interview_preparations_user_job_version_uniq").on(t.userId, t.jobId, t.version),
    versionPositive: check("interview_preparations_version_positive", sql`${t.version} >= 1`),
    sectionsIsObject: check("interview_preparations_sections_object", sql`jsonb_typeof(${t.sections}) = 'object'`),
    gapTermsIsArray: check("interview_preparations_gap_terms_array", sql`jsonb_typeof(${t.gapTermsSnapshot}) = 'array'`),
  })
);
