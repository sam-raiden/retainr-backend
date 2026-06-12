import { z } from 'zod';

export const PlanCreateSchema = z.object({
  name: z.string().trim().min(2, 'Plan name must be at least 2 characters').max(40),
  price: z.number().int('Price must be a whole number').min(0).max(1000000),
  duration_months: z.number().int().min(1).max(36),
});
export type PlanCreateInput = z.infer<typeof PlanCreateSchema>;
