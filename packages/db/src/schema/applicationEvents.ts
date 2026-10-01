import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { applications, applicationStatusEnum } from "./applications";

export const applicationEventTypeEnum = pgEnum("application_event_type", [
  "status_change", "note", "recruiter_contact", "interview", "follow_up_done", "follow_up_snoozed", "documents_purged",
]);

/**
 * Phase 9 design §3. Append-only: application code never updates or deletes a row; only the
 * applications cascade removes them. detail is validated per type by packages/applications (Zod).
 * to_status is required exactly for status_change (from_status is null on the creation event).
 */
export const applicationEvents = pgTable(
  "application_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    type: applicationEventTypeEnum("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    fromStatus: applicationStatusEnum("from_status"),
    toStatus: applicationStatusEnum("to_status"),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    applicationOccurredIdx: index("application_events_application_occurred_idx").on(t.applicationId, t.occurredAt),
    detailIsObject: check("application_events_detail_object", sql`jsonb_typeof(${t.detail}) = 'object'`),
    statusFieldsMatchType: check(
      "application_events_status_fields_match_type",
      sql`(${t.type}::text = 'status_change') = (${t.toStatus} IS NOT NULL)
        AND (${t.fromStatus} IS NULL OR ${t.type}::text = 'status_change')`
    ),
  })
);
