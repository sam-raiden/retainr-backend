import { z } from 'zod';

import { PhoneSchema } from './common.js';

/**
 * Used by POST /api/v1/gyms — onboarding a new tenant.
 *
 * The single SECURITY DEFINER call `create_gym_with_owner()` inserts both
 * the gym row and its first staff row in one transaction.
 */
export const GymCreateSchema = z.object({
  gym_name: z.string().min(1).max(120),
  owner_name: z.string().min(1).max(120),
  owner_phone: PhoneSchema,
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(200),
});
export type GymCreateInput = z.infer<typeof GymCreateSchema>;
