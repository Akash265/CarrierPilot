CREATE INDEX "application_pitches_company_research_id_idx" ON "application_pitches" USING btree ("company_research_id") WHERE "application_pitches"."company_research_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "application_pitches_job_id_idx" ON "application_pitches" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "application_pitches_parent_pitch_id_idx" ON "application_pitches" USING btree ("parent_pitch_id") WHERE "application_pitches"."parent_pitch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "applications_application_pitch_id_idx" ON "applications" USING btree ("application_pitch_id") WHERE "applications"."application_pitch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "applications_cover_letter_id_idx" ON "applications" USING btree ("cover_letter_id") WHERE "applications"."cover_letter_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "applications_job_id_idx" ON "applications" USING btree ("job_id") WHERE "applications"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "applications_resume_optimization_id_idx" ON "applications" USING btree ("resume_optimization_id") WHERE "applications"."resume_optimization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_sessions_cover_letter_document_id_idx" ON "automation_sessions" USING btree ("cover_letter_document_id") WHERE "automation_sessions"."cover_letter_document_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_sessions_job_id_idx" ON "automation_sessions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "automation_sessions_resume_document_id_idx" ON "automation_sessions" USING btree ("resume_document_id") WHERE "automation_sessions"."resume_document_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cover_letters_company_research_id_idx" ON "cover_letters" USING btree ("company_research_id") WHERE "cover_letters"."company_research_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cover_letters_job_id_idx" ON "cover_letters" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "cover_letters_parent_cover_letter_id_idx" ON "cover_letters" USING btree ("parent_cover_letter_id") WHERE "cover_letters"."parent_cover_letter_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generated_documents_application_pitch_id_idx" ON "generated_documents" USING btree ("application_pitch_id") WHERE "generated_documents"."application_pitch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generated_documents_cover_letter_id_idx" ON "generated_documents" USING btree ("cover_letter_id") WHERE "generated_documents"."cover_letter_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generated_documents_interview_preparation_id_idx" ON "generated_documents" USING btree ("interview_preparation_id") WHERE "generated_documents"."interview_preparation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generated_documents_resume_optimization_id_idx" ON "generated_documents" USING btree ("resume_optimization_id") WHERE "generated_documents"."resume_optimization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "work_experience_bullets_work_experience_id_idx" ON "work_experience_bullets" USING btree ("work_experience_id");--> statement-breakpoint
CREATE INDEX "job_duplicate_candidates_job_id_b_idx" ON "job_duplicate_candidates" USING btree ("job_id_b");--> statement-breakpoint
CREATE INDEX "job_matches_career_goal_id_idx" ON "job_matches" USING btree ("career_goal_id");--> statement-breakpoint
CREATE INDEX "job_matches_job_id_idx" ON "job_matches" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "matching_runs_career_goal_id_idx" ON "matching_runs" USING btree ("career_goal_id");--> statement-breakpoint
CREATE INDEX "resume_optimizations_career_goal_id_idx" ON "resume_optimizations" USING btree ("career_goal_id");--> statement-breakpoint
CREATE INDEX "resume_optimizations_job_id_idx" ON "resume_optimizations" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "interview_preparations_company_research_id_idx" ON "interview_preparations" USING btree ("company_research_id") WHERE "interview_preparations"."company_research_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "interview_preparations_job_id_idx" ON "interview_preparations" USING btree ("job_id");