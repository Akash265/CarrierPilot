-- Custom SQL migration: RLS + partial unique index for the Phase 9 tables. Follows 0023 and 0010.

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON applications
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE application_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON application_events
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- One application per ingested job; external applications (job_id NULL) are unconstrained.
CREATE UNIQUE INDEX applications_user_job_uniq ON applications (user_id, job_id) WHERE job_id IS NOT NULL;
