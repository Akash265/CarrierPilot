import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, integer, boolean, jsonb, timestamp, uniqueIndex, check, type AnyPgColumn,
  index,
} from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { companyResearch, companyResearchStatusEnum } from "./companyResearch";

export const coverLetterOriginEnum = pgEnum("cover_letter_origin", ["generated", "user_edited"]);

/**
 * Phase 7c design §3. One row per generated or user-edited version; never updated in place. version
 * increments per (user_id, job_id) under an advisory lock (application-package insertCoverLetterVersion).
 * paragraphs: StoredCoverLetterParagraph[] -- 4 or 5, ordered opening, company, evidence (1-2), closing:
 * [{ role, text, supported: boolean | null (null = user_edited), unsupportedReason, evidence: [snapshot] }].
 */
export const coverLetters = pgTable(
  "cover_letters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    origin: coverLetterOriginEnum("origin").notNull(),
    parentCoverLetterId: uuid("parent_cover_letter_id").references((): AnyPgColumn => coverLetters.id, { onDelete: "set null" }),
    companyResearchId: uuid("company_research_id").references(() => companyResearch.id, { onDelete: "set null" }),
    researchStatusSnapshot: companyResearchStatusEnum("research_status_snapshot").notNull(),
    researchedAtSnapshot: timestamp("researched_at_snapshot", { withTimezone: true }),
    paragraphs: jsonb("paragraphs").notNull(),
    requiresReview: boolean("requires_review").notNull(),
    sourceProfileContentHash: text("source_profile_content_hash"),
    generationModel: text("generation_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobVersionUniq: uniqueIndex("cover_letters_user_job_version_uniq").on(t.userId, t.jobId, t.version),
    versionPositive: check("cover_letters_version_positive", sql`${t.version} >= 1`),
    // CASE, not AND: Postgres does not guarantee AND short-circuits (same as application_pitches_bullets_three).
    paragraphsFourOrFive: check(
      "cover_letters_paragraphs_four_or_five",
      sql`CASE WHEN jsonb_typeof(${t.paragraphs}) = 'array' THEN jsonb_array_length(${t.paragraphs}) BETWEEN 4 AND 5 ELSE false END`
    ),
    // Phase 11c (D181): one index per foreign key, so a change to the parent row never scans this table.
    companyResearchIdFkIdx: index("cover_letters_company_research_id_idx").on(t.companyResearchId).where(sql`${t.companyResearchId} IS NOT NULL`),
    jobIdFkIdx: index("cover_letters_job_id_idx").on(t.jobId),
    parentCoverLetterIdFkIdx: index("cover_letters_parent_cover_letter_id_idx").on(t.parentCoverLetterId).where(sql`${t.parentCoverLetterId} IS NOT NULL`),
  })
);
