import { withTenant } from '../db/pool.js';
import type { PlanCreateInput } from '../schemas/plan.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';

export interface GymPlan {
  id: string;
  name: string;
  price: number;
  duration_months: number;
  is_active: boolean;
}

export async function listActivePlans(gymId: string): Promise<GymPlan[]> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<GymPlan>(
      `SELECT id, name, price, duration_months, is_active
       FROM gym_plans
       WHERE is_active = true
       ORDER BY created_at`,
    );
    return r.rows;
  });
}

/** Creates a custom plan for this gym. Plan names must be unique among active plans. */
export async function createPlan(gymId: string, input: PlanCreateInput): Promise<GymPlan> {
  return withTenant(gymId, async (client) => {
    const existing = await client.query(
      `SELECT id FROM gym_plans WHERE is_active = true AND lower(name) = lower($1)`,
      [input.name],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new ConflictError(`A plan named "${input.name}" already exists`);
    }

    const r = await client.query<GymPlan>(
      `INSERT INTO gym_plans (gym_id, name, price, duration_months, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, name, price, duration_months, is_active`,
      [gymId, input.name, input.price, input.duration_months],
    );
    return r.rows[0]!;
  });
}

/** Deactivates a plan (soft delete — members already on it are unaffected). */
export async function deactivatePlan(gymId: string, planId: string): Promise<GymPlan> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<GymPlan>(
      `UPDATE gym_plans SET is_active = false
       WHERE id = $1
       RETURNING id, name, price, is_active`,
      [planId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError('Plan not found');
    return row;
  });
}
