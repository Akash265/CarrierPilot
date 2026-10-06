-- Custom SQL migration: RLS + partial unique indexes for the Phase 8 table. Follows 0025.

ALTER TABLE automation_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON automation_sessions
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- One automated browser window per user at a time (design §3).
CREATE UNIQUE INDEX automation_sessions_one_active_per_user ON automation_sessions (user_id)
  WHERE status IN ('queued'::automation_status, 'launching'::automation_status, 'filling'::automation_status, 'awaiting_user'::automation_status);

-- An application is linked by at most one session.
CREATE UNIQUE INDEX automation_sessions_application_uniq ON automation_sessions (application_id)
  WHERE application_id IS NOT NULL;