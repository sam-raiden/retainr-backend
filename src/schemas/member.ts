import { z } from 'zod';

import { isValidCalendarDate, daysBetween, todayIST } from '../services/dates.js';
import { ISODateSchema, PhoneSchema, PlanSchema } from './common.js';

// ------------------------------------------------------------------------
// CRUD inputs
// ------------------------------------------------------------------------

export const MemberCreateSchema = z.object({
  name: z.string().min(1).max(120),
  phone: PhoneSchema,
  plan: PlanSchema,
  payment_date: ISODateSchema,
  photo_url: z.string().nullable().optional(),
});
export type MemberCreateInput = z.infer<typeof MemberCreateSchema>;

export const MemberUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    phone: PhoneSchema.optional(),
    plan: PlanSchema.optional(),
    payment_date: ISODateSchema.optional(),
    photo_url: z.string().nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided.',
  });
export type MemberUpdateInput = z.infer<typeof MemberUpdateSchema>;

// ------------------------------------------------------------------------
// Renew — POST /api/v1/members/:id/renew
// ------------------------------------------------------------------------

export const MemberRenewSchema = z.object({
  plan: PlanSchema.optional(),
  payment_method: z.enum(['CASH', 'GPAY']),
});
export type MemberRenewInput = z.infer<typeof MemberRenewSchema>;

// ------------------------------------------------------------------------
// Query strings
// ------------------------------------------------------------------------

export const MemberListQuerySchema = z.object({
  status: z.enum(['all', 'active', 'expiring', 'expired']).optional(),
  search: z.string().trim().max(80).optional(),
});
export type MemberListQuery = z.infer<typeof MemberListQuerySchema>;

// ------------------------------------------------------------------------
// Bulk import (notebook → DB onboarding tool, step 6)
//
// `plan` can only be checked against this gym's *active* plans, which is a
// DB lookup — so the row schema is built per-request via this factory once
// the active plan names are known. The endpoint handler runs each CSV row
// through `createBulkImportRowSchema(activePlans).safeParse(...)` and
// reports per-row errors with the original line number.
// ------------------------------------------------------------------------

export function createBulkImportRowSchema(activePlanNames: readonly string[]) {
  const planSet = new Set(activePlanNames);
  return z.object({
    name: z.string().trim().min(1, 'Name is required'),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9]{10}$/, 'Phone must be exactly 10 digits'),
    plan: z
      .string()
      .trim()
      .min(1, 'Plan is required')
      .refine((p) => planSet.has(p), () => ({
        message: `Plan must be one of this gym's active plans: ${activePlanNames.join(', ') || '(none active)'}`,
      })),
    payment_date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
      .refine((d) => isValidCalendarDate(d), 'Not a real calendar date')
      .refine((d) => !isValidCalendarDate(d) || daysBetween(todayIST(), d) <= 1, {
        message: 'Payment date cannot be more than 1 day in the future',
      }),
  });
}
export type BulkImportRow = z.infer<ReturnType<typeof createBulkImportRowSchema>>;
