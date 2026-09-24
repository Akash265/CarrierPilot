-- Custom SQL migration: RLS for generated_documents. Follows 0018_application_package_rls.sql.

ALTER TABLE generated_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON generated_documents
  USING (user_id = current_setting('app.current_user_id')::uuid);
