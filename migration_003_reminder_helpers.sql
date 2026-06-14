-- Migration 003: cross-tenant helper for the daily WhatsApp reminder cron.
--
-- The cron needs to enumerate every gym's id + sms_credits/sms_frozen before
-- looping into withTenant(gymId, ...) for the actual member queries. Plain
-- `unscoped()` runs as app_backend (NOBYPASSRLS) with no app.current_gym_id
-- set, so `SELECT * FROM gyms` correctly returns zero rows there. A
-- SECURITY DEFINER function (same pattern as auth_lookup_staff /
-- create_gym_with_owner) is the sanctioned escape hatch.
CREATE OR REPLACE FUNCTION public.list_gyms_for_reminders()
 RETURNS TABLE(gym_id uuid, name text, sms_credits integer, sms_frozen boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id, name, sms_credits, sms_frozen FROM gyms;
$function$;

GRANT EXECUTE ON FUNCTION public.list_gyms_for_reminders() TO app_backend;
