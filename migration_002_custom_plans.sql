-- Migration 002: custom membership plans (name + price + duration)
--
-- 1. gym_plans gets a duration_months column. Existing rows (the two
--    seeded "Standard"/"Weight Loss" plans for every gym) default to 1,
--    matching today's hardcoded PLAN_DURATION_MONTHS behaviour.
ALTER TABLE gym_plans
  ADD COLUMN IF NOT EXISTS duration_months smallint NOT NULL DEFAULT 1
    CHECK (duration_months BETWEEN 1 AND 36);

-- 2. members.plan currently has a CHECK constraint limiting it to
--    ('Standard', 'Weight Loss'). Drop it so members can be assigned to
--    custom plans created via POST /api/v1/plans. Application-level
--    validation (against this gym's active plan names) takes over.
DO $$
DECLARE
  con record;
  plan_attnum smallint;
BEGIN
  SELECT attnum INTO plan_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.members'::regclass AND attname = 'plan';

  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.members'::regclass
      AND contype = 'c'
      AND plan_attnum = ANY(conkey)
  LOOP
    EXECUTE format('ALTER TABLE public.members DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

-- 3. create_gym_with_owner: seed the two default plans with an explicit
--    duration_months (was previously implicit via column default — being
--    explicit here documents the intent now that other durations exist).
CREATE OR REPLACE FUNCTION public.create_gym_with_owner(p_gym_name text, p_owner_name text, p_owner_phone text, p_email text, p_password_hash text)
 RETURNS TABLE(gym_id uuid, staff_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_gym_id   UUID;
  new_staff_id UUID;
BEGIN
  INSERT INTO gyms (name, owner_name, owner_phone)
    VALUES (p_gym_name, p_owner_name, p_owner_phone)
    RETURNING id INTO new_gym_id;

  INSERT INTO staff (gym_id, email, password_hash, role)
    VALUES (new_gym_id, lower(p_email), p_password_hash, 'owner')
    RETURNING id INTO new_staff_id;

  INSERT INTO gym_plans (gym_id, name, price, duration_months) VALUES
    (new_gym_id, 'Standard', 800, 1),
    (new_gym_id, 'Weight Loss', 1500, 1);

  RETURN QUERY SELECT new_gym_id, new_staff_id;
END;
$function$;
