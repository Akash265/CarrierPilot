import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, date, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { resumeOptimizations } from "./resumeOptimizations";
import { applicationPitches } from "./applicationPitches";
import { coverLetters } from "./coverLetters";

export const applicationStatusEnum = pgEnum("application_status", [
  "applied", "screening", "interviewing", "offer", "accepted", "declined", "rejected", "withdrawn", "no_response",
]);

/**
 * Phase 9 design §3. One row per application -- to an ingested job (job_id set) or an external one
 * (job_id null, company/title typed in). company_name/job_title are always filled so the tracker never
 * depends on the job row still existing (job delete -> SET NULL). The partial unique index
 * (user_id, job_id) WHERE job_id IS NOT NULL lives in the custom migration 0025, like 0010's partial index.
 * feature_snapshot is written once at creation (Phase 10 input) and never updated.
 * terminal_at is the retention clock: set when the status becomes terminal, cleared on reopen.
 */
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    companyName: text("company_name").notNull(),
    jobTitle: text("job_title").notNull(),
    jobUrl: text("job_url"),
    status: applicationStatusEnum("status").notNull().default("applied"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull(),
    appliedAt: date("applied_at", { mode: "string" }).notNull(),
    followUpAt: date("follow_up_at", { mode: "string" }),
    recruiterName: text("recruiter_name"),
    recruiterContact: text("recruiter_contact"),
    salaryNotes: text("salary_notes"),
    notes: text("notes"),
    resumeOptimizationId: uuid("resume_optimization_id").references(() => resumeOptimizations.id, { onDelete: "set null" }),
    applicationPitchId: uuid("application_pitch_id").references(() => applicationPitches.id, { onDelete: "set null" }),
    coverLetterId: uuid("cover_letter_id").references(() => coverLetters.id, { onDelete: "set null" }),
    featureSnapshot: jsonb("feature_snapshot").notNull(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    retentionPurgedAt: timestamp("retention_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userFollowUpIdx: index("applications_user_follow_up_idx").on(t.userId, t.followUpAt),
    userStatusIdx: index("applications_user_status_idx").on(t.userId, t.status),
    snapshotIsObject: check("applications_feature_snapshot_object", sql`jsonb_typeof(${t.featureSnapshot}) = 'object'`),
    // status::text, not a bare enum literal: same one-transaction migrator caveat as generated_documents.
    terminalAtMatchesStatus: check(
      "applications_terminal_at_matches_status",
      sql`(${t.status}::text IN ('accepted', 'declined', 'rejected', 'withdrawn', 'no_response')) = (${t.terminalAt} IS NOT NULL)`
    ),
    namesNotBlank: check(
      "applications_names_not_blank",
      sql`char_length(btrim(${t.companyName})) > 0 AND char_length(btrim(${t.jobTitle})) > 0`
    ),
  })
);
