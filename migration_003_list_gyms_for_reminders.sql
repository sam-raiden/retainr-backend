-- Migration 003: SECURITY DEFINER helper for the daily reminder cron.
--
-- The cron job runs on behalf of ALL gyms, but withTenant() requires a
-- gym_id to scope each query. This function lets the cron fetch every
-- gym's id + name without bypassing row-level security on member data:
-- it runs as the function owner (postgres, BYPASSRLS) only for this one
-- "list gyms" query; all subsequent per-gym member queries still use
-- withTenant() and app_backend (NOBYPASSRLS).

CREATE OR REPLACE FUNCTION public.list_gyms_for_reminders()
RETURNS TABLE(gym_id uuid, gym_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id AS gym_id, name AS gym_name
  FROM gyms
  ORDER BY id;
$$;

GRANT EXECUTE ON FUNCTION public.list_gyms_for_reminders() TO app_backend;
