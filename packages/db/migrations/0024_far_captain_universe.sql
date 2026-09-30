CREATE TYPE "public"."application_event_type" AS ENUM('status_change', 'note', 'recruiter_contact', 'interview', 'follow_up_done', 'follow_up_snoozed', 'documents_purged');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('applied', 'screening', 'interviewing', 'offer', 'accepted', 'declined', 'rejected', 'withdrawn', 'no_response');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"type" "application_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"from_status" "application_status",
	"to_status" "application_status",
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_events_detail_object" CHECK (jsonb_typeof("application_events"."detail") = 'object'),
	CONSTRAINT "application_events_status_fields_match_type" CHECK (("application_events"."type"::text = 'status_change') = ("application_events"."to_status" IS NOT NULL)
        AND ("application_events"."from_status" IS NULL OR "application_events"."type"::text = 'status_change'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid,
	"company_name" text NOT NULL,
	"job_title" text NOT NULL,
	"job_url" text,
	"status" "application_status" DEFAULT 'applied' NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	"applied_at" date NOT NULL,
	"follow_up_at" date,
	"recruiter_name" text,
	"recruiter_contact" text,
	"salary_notes" text,
	"notes" text,
	"resume_optimization_id" uuid,
	"application_pitch_id" uuid,
	"cover_letter_id" uuid,
	"feature_snapshot" jsonb NOT NULL,
	"terminal_at" timestamp with time zone,
	"retention_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_feature_snapshot_object" CHECK (jsonb_typeof("applications"."feature_snapshot") = 'object'),
	CONSTRAINT "applications_terminal_at_matches_status" CHECK (("applications"."status"::text IN ('accepted', 'declined', 'rejected', 'withdrawn', 'no_response')) = ("applications"."terminal_at" IS NOT NULL)),
	CONSTRAINT "applications_names_not_blank" CHECK (char_length(btrim("applications"."company_name")) > 0 AND char_length(btrim("applications"."job_title")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_optimization_id_resume_optimizations_id_fk" FOREIGN KEY ("resume_optimization_id") REFERENCES "public"."resume_optimizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applications" ADD CONSTRAINT "applications_application_pitch_id_application_pitches_id_fk" FOREIGN KEY ("application_pitch_id") REFERENCES "public"."application_pitches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applications" ADD CONSTRAINT "applications_cover_letter_id_cover_letters_id_fk" FOREIGN KEY ("cover_letter_id") REFERENCES "public"."cover_letters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_events_application_occurred_idx" ON "application_events" USING btree ("application_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_user_follow_up_idx" ON "applications" USING btree ("user_id","follow_up_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_user_status_idx" ON "applications" USING btree ("user_id","status");