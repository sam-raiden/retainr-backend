import { z } from 'zod';

// UUID v4 — what every primary key and tenant FK uses.
export const UUIDSchema = z.string().uuid();

// `:id` route params across the API.
export const IdParamSchema = z.object({ id: UUIDSchema });

// Indian phone, 10 digits exactly. Matches the CHECK constraint on
// gyms.owner_phone and members.phone, so a Zod-validated value will
// never fail at the database layer.
export const PhoneSchema = z
  .string()
  .regex(
    /^[0-9]{10}$/,
    'Phone must be exactly 10 digits — no spaces, no +91, no dashes.',
  );

// YYYY-MM-DD calendar date (no time component).
export const ISODateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format.');

// A plan name on a member create/update/renew request. Format-only check —
// the route handler validates it against this gym's *active* gym_plans
// names (a DB lookup, so it can't live in this static schema).
export const PlanSchema = z.string().trim().min(1).max(60);

export const PaymentStatusSchema = z.enum(['PAID', 'UNPAID']);
