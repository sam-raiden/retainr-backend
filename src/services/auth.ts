import bcrypt from 'bcrypt';

import { unscoped, withTenant } from '../db/pool.js';

const SALT_ROUNDS = 12;

// Hashed once at boot. Used as the comparison target when no staff row
// matches the given email, so login takes the same time either way and
// doesn't leak which emails are registered via response timing.
const DUMMY_HASH = bcrypt.hashSync('no-such-account', SALT_ROUNDS);

export interface StaffAuthRow {
  staff_id: string;
  gym_id: string;
  password_hash: string;
  role: string;
}

export interface GymSummary {
  id: string;
  name: string;
  owner_name: string;
  owner_phone: string;
  sms_credits: number;
  sms_frozen: boolean;
}

export interface StaffSummary {
  id: string;
  email: string;
  role: string;
}

/** SECURITY DEFINER lookup — runs before tenant context exists. */
export async function lookupStaffByEmail(email: string): Promise<StaffAuthRow | null> {
  const r = await unscoped<StaffAuthRow>('SELECT * FROM auth_lookup_staff($1)', [email]);
  return r.rows[0] ?? null;
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export interface CreateGymInput {
  gymName: string;
  ownerName: string;
  ownerPhone: string;
  email: string;
  passwordHash: string;
}

/** SECURITY DEFINER insert — runs before tenant context exists. */
export async function createGym(
  input: CreateGymInput,
): Promise<{ gymId: string; staffId: string }> {
  const r = await unscoped<{ gym_id: string; staff_id: string }>(
    'SELECT * FROM create_gym_with_owner($1, $2, $3, $4, $5)',
    [input.gymName, input.ownerName, input.ownerPhone, input.email, input.passwordHash],
  );
  const row = r.rows[0];
  if (!row) throw new Error('create_gym_with_owner returned no row');
  return { gymId: row.gym_id, staffId: row.staff_id };
}

export async function getGymSummary(gymId: string): Promise<GymSummary> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<GymSummary>(
      'SELECT id, name, owner_name, owner_phone, sms_credits, sms_frozen FROM gyms WHERE id = $1',
      [gymId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`gym ${gymId} not found`);
    return row;
  });
}

export async function getStaffSummary(gymId: string, staffId: string): Promise<StaffSummary> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<StaffSummary>(
      'SELECT id, email, role FROM staff WHERE id = $1',
      [staffId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`staff ${staffId} not found in gym ${gymId}`);
    return row;
  });
}
