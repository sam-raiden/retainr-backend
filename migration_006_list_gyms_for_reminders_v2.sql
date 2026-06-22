-- Migration 006: rebuild list_gyms_for_reminders() to return all 4 fields
--
-- Previous version (migration_003) only returned gym_id + gym_name.
-- The daily cron (GymRow interface) also needs sms_credits + sms_frozen
-- so the credit guardrail actually works.

CREATE OR REPLACE FUNCTION public.list_gyms_for_reminders()
RETURNS TABLE(
  gym_id      uuid,
  gym_name    text,
  sms_credits integer,
  sms_frozen  boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id AS gym_id, name AS gym_name, sms_credits, sms_frozen
  FROM gyms
  ORDER BY id;
$$;

GRANT EXECUTE ON FUNCTION public.list_gyms_for_reminders() TO app_backend;
