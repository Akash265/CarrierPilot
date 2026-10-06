CREATE TYPE "public"."automation_portal" AS ENUM('greenhouse', 'lever');--> statement-breakpoint
CREATE TYPE "public"."automation_status" AS ENUM('queued', 'launching', 'filling', 'awaiting_user', 'submission_detected', 'abandoned', 'needs_manual', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"application_id" uuid,
	"portal" "automation_portal" NOT NULL,
	"adapter_version" text NOT NULL,
	"form_url" text NOT NULL,
	"status" "automation_status" DEFAULT 'queued' NOT NULL,
	"resume_document_id" uuid,
	"cover_letter_document_id" uuid,
	"field_audit" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stopped_before_submit" boolean DEFAULT true NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"error_code" text,
	"submission_detected_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_sessions_field_audit_array" CHECK (jsonb_typeof("automation_sessions"."field_audit") = 'array'),
	CONSTRAINT "automation_sessions_ended_at_matches_status" CHECK (("automation_sessions"."status"::text IN ('submission_detected', 'abandoned', 'needs_manual', 'failed')) = ("automation_sessions"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_resume_document_id_generated_documents_id_fk" FOREIGN KEY ("resume_document_id") REFERENCES "public"."generated_documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_cover_letter_document_id_generated_documents_id_fk" FOREIGN KEY ("cover_letter_document_id") REFERENCES "public"."generated_documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_sessions_user_job_created_idx" ON "automation_sessions" USING btree ("user_id","job_id","created_at");