/**
 * Supabase client for Storage only — all relational data goes through
 * `src/db/pool.ts` (direct Postgres + RLS). This client uses the service
 * role key, which bypasses Storage RLS entirely, so it must never be
 * exposed to the frontend and every call site must pass an
 * already-tenant-scoped path (gym_id/member_id/...).
 */
import { createClient } from '@supabase/supabase-js';

import { env } from '../config/env.js';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
