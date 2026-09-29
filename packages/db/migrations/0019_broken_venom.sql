CREATE TYPE "public"."generated_document_format" AS ENUM('pdf', 'docx');--> statement-breakpoint
CREATE TYPE "public"."generated_document_kind" AS ENUM('resume', 'pitch');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "generated_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" "generated_document_kind" NOT NULL,
	"format" "generated_document_format" NOT NULL,
	"resume_optimization_id" uuid,
	"application_pitch_id" uuid,
	"object_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"renderer_version" text NOT NULL,
	"download_filename" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generated_documents_byte_size_positive" CHECK ("generated_documents"."byte_size" > 0),
	CONSTRAINT "generated_documents_source_matches_kind" CHECK (("generated_documents"."kind" = 'resume' AND "generated_documents"."application_pitch_id" IS NULL) OR ("generated_documents"."kind" = 'pitch' AND "generated_documents"."resume_optimization_id" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_resume_optimization_id_resume_optimizations_id_fk" FOREIGN KEY ("resume_optimization_id") REFERENCES "public"."resume_optimizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_application_pitch_id_application_pitches_id_fk" FOREIGN KEY ("application_pitch_id") REFERENCES "public"."application_pitches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "generated_documents_user_kind_format_hash_uniq" ON "generated_documents" USING btree ("user_id","kind","format","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generated_documents_job_id_idx" ON "generated_documents" USING btree ("job_id");