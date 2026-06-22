-- Migration 004: message_log table
--
-- Records every WhatsApp send attempt made by the daily reminder cron.
-- gym_id scopes all rows so RLS (via withTenant) isolates them per tenant.

CREATE TABLE IF NOT EXISTS message_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id               uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id            uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  template             text NOT NULL,
  status               text NOT NULL CHECK (status IN ('SENT', 'FAILED')),
  provider_message_id  text,
  error_text           text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Index for per-gym log queries (Finance / audit view)
CREATE INDEX IF NOT EXISTS message_log_gym_created
  ON message_log (gym_id, created_at DESC);

-- Index for per-member history
CREATE INDEX IF NOT EXISTS message_log_member
  ON message_log (member_id, created_at DESC);

-- Row-level security — same pattern as members / payments
ALTER TABLE message_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_log_gym ON message_log;
CREATE POLICY message_log_gym ON message_log
  USING (gym_id = current_setting('app.current_gym_id', true)::uuid)
  WITH CHECK (gym_id = current_setting('app.current_gym_id', true)::uuid);

-- Grant to the restricted backend role used by withTenant()
GRANT SELECT, INSERT ON message_log TO app_backend;
