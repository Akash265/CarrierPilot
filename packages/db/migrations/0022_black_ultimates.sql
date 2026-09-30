CREATE TYPE "public"."cover_letter_origin" AS ENUM('generated', 'user_edited');--> statement-breakpoint
ALTER TYPE "public"."generated_document_kind" ADD VALUE 'cover_letter';--> statement-breakpoint
ALTER TYPE "public"."generated_document_kind" ADD VALUE 'interview_prep';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cover_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"origin" "cover_letter_origin" NOT NULL,
	"parent_cover_letter_id" uuid,
	"company_research_id" uuid,
	"research_status_snapshot" "company_research_status" NOT NULL,
	"researched_at_snapshot" timestamp with time zone,
	"paragraphs" jsonb NOT NULL,
	"requires_review" boolean NOT NULL,
	"source_profile_content_hash" text,
	"generation_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cover_letters_version_positive" CHECK ("cover_letters"."version" >= 1),
	CONSTRAINT "cover_letters_paragraphs_four_or_five" CHECK (CASE WHEN jsonb_typeof("cover_letters"."paragraphs") = 'array' THEN jsonb_array_length("cover_letters"."paragraphs") BETWEEN 4 AND 5 ELSE false END)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interview_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT current_setting('app.current_user_id')::uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"company_research_id" uuid,
	"research_status_snapshot" "company_research_status" NOT NULL,
	"researched_at_snapshot" timestamp with time zone,
	"sections" jsonb NOT NULL,
	"gap_terms_snapshot" jsonb NOT NULL,
	"requires_review" boolean NOT NULL,
	"source_profile_content_hash" text NOT NULL,
	"generation_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_preparations_version_positive" CHECK ("interview_preparations"."version" >= 1),
	CONSTRAINT "interview_preparations_sections_object" CHECK (jsonb_typeof("interview_preparations"."sections") = 'object'),
	CONSTRAINT "interview_preparations_gap_terms_array" CHECK (jsonb_typeof("interview_preparations"."gap_terms_snapshot") = 'array')
);
--> statement-breakpoint
ALTER TABLE "generated_documents" DROP CONSTRAINT "generated_documents_source_matches_kind";--> statement-breakpoint
ALTER TABLE "generated_documents" ADD COLUMN "cover_letter_id" uuid;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD COLUMN "interview_preparation_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cover_letters" ADD CONSTRAINT "cover_letters_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cover_letters" ADD CONSTRAINT "cover_letters_parent_cover_letter_id_cover_letters_id_fk" FOREIGN KEY ("parent_cover_letter_id") REFERENCES "public"."cover_letters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cover_letters" ADD CONSTRAINT "cover_letters_company_research_id_company_research_id_fk" FOREIGN KEY ("company_research_id") REFERENCES "public"."company_research"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interview_preparations" ADD CONSTRAINT "interview_preparations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interview_preparations" ADD CONSTRAINT "interview_preparations_company_research_id_company_research_id_fk" FOREIGN KEY ("company_research_id") REFERENCES "public"."company_research"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cover_letters_user_job_version_uniq" ON "cover_letters" USING btree ("user_id","job_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "interview_preparations_user_job_version_uniq" ON "interview_preparations" USING btree ("user_id","job_id","version");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_cover_letter_id_cover_letters_id_fk" FOREIGN KEY ("cover_letter_id") REFERENCES "public"."cover_letters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_interview_preparation_id_interview_preparations_id_fk" FOREIGN KEY ("interview_preparation_id") REFERENCES "public"."interview_preparations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_source_matches_kind" CHECK (("generated_documents"."resume_optimization_id" IS NULL OR "generated_documents"."kind"::text = 'resume')
        AND ("generated_documents"."application_pitch_id" IS NULL OR "generated_documents"."kind"::text = 'pitch')
        AND ("generated_documents"."cover_letter_id" IS NULL OR "generated_documents"."kind"::text = 'cover_letter')
        AND ("generated_documents"."interview_preparation_id" IS NULL OR "generated_documents"."kind"::text = 'interview_prep'));