-- Custom SQL migration: RLS for the Phase 11a ai_calls table. Follows 0027.
-- Append-only by policy, not by grant: the app role holds UPDATE/DELETE on every table through the
-- default privileges in infra/postgres/init.sql, so only command-specific policies can stop it. With RLS
-- enabled and no UPDATE or DELETE policy, those statements match no rows.

ALTER TABLE ai_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_calls_select ON ai_calls FOR SELECT
  USING (user_id = current_setting('app.current_user_id')::uuid);
CREATE POLICY ai_calls_insert ON ai_calls FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id')::uuid);
