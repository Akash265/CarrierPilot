-- Custom SQL migration: RLS for the Phase 7c tables. Follows 0020_generated_documents_rls.sql.

ALTER TABLE cover_letters ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON cover_letters
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE interview_preparations ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON interview_preparations
  USING (user_id = current_setting('app.current_user_id')::uuid);
