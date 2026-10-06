import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, boolean, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { applications } from "./applications";
import { generatedDocuments } from "./generatedDocuments";

export const automationPortalEnum = pgEnum("automation_portal", ["greenhouse", "lever"]);
export const automationStatusEnum = pgEnum("automation_status", [
  "queued", "launching", "filling", "awaiting_user", "submission_detected", "abandoned", "needs_manual", "failed",
]);

/**
 * Phase 8 design §3. One row per autofill attempt. field_audit holds FieldAuditEntry[] (packages/browser
 * types.ts) and never a field value (CLAUDE.md §9). The partial unique indexes -- at most one active
 * session per user, and one session per linked application -- live in the custom migration 0027.
 * stopped_before_submit is the spec §19 flag: the worker has no submit path, so it is never set false.
 */
export const automationSessions = pgTable(
  "automation_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
    portal: automationPortalEnum("portal").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    formUrl: text("form_url").notNull(),
    status: automationStatusEnum("status").notNull().default("queued"),
    resumeDocumentId: uuid("resume_document_id").references(() => generatedDocuments.id, { onDelete: "set null" }),
    coverLetterDocumentId: uuid("cover_letter_document_id").references(() => generatedDocuments.id, { onDelete: "set null" }),
    fieldAudit: jsonb("field_audit").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    stoppedBeforeSubmit: boolean("stopped_before_submit").notNull().default(true),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    errorCode: text("error_code"),
    submissionDetectedAt: timestamp("submission_detected_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobCreatedIdx: index("automation_sessions_user_job_created_idx").on(t.userId, t.jobId, t.createdAt),
    auditIsArray: check("automation_sessions_field_audit_array", sql`jsonb_typeof(${t.fieldAudit}) = 'array'`),
    // status::text, not a bare enum literal: same one-transaction migrator caveat as applications.
    endedAtMatchesStatus: check(
      "automation_sessions_ended_at_matches_status",
      sql`(${t.status}::text IN ('submission_detected', 'abandoned', 'needs_manual', 'failed')) = (${t.endedAt} IS NOT NULL)`
    ),
  })
);
