import { parse } from 'csv-parse/sync';
import type { PoolClient } from 'pg';

import { withTenant } from '../db/pool.js';
import { createBulkImportRowSchema } from '../schemas/member.js';
import { HttpError } from '../utils/errors.js';
import { PLAN_DURATION_MONTHS, addCalendarMonths, todayIST } from './dates.js';

interface ActivePlan {
  name: string;
  duration_months: number;
}

const REQUIRED_COLUMNS = ['name', 'phone', 'plan', 'payment_date'] as const;

export interface BulkImportRowError {
  row: number;
  data: Record<string, string>;
  reason: string;
}

export interface BulkImportReport {
  imported: number;
  skipped: number;
  errors: BulkImportRowError[];
}

/**
 * Parses a CSV buffer into header-keyed records. Header names are
 * trimmed/lowercased so `Name`, ` name `, `NAME` all map to `name`.
 * Throws a 400 HttpError if the file can't be parsed or is missing one of
 * the required columns (even if it has zero data rows).
 */
export function parseMembersCsv(buffer: Buffer): Record<string, string>[] {
  let headerColumns: string[] = [];
  let records: Record<string, string>[];

  try {
    records = parse(buffer, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      columns: (header: string[]) => {
        headerColumns = header.map((h) => h.trim().toLowerCase());
        return headerColumns;
      },
    }) as Record<string, string>[];
  } catch (err) {
    throw new HttpError(400, `Could not parse CSV: ${(err as Error).message}`);
  }

  const missing = REQUIRED_COLUMNS.filter((c) => !headerColumns.includes(c));
  if (missing.length > 0) {
    throw new HttpError(400, `CSV is missing required column(s): ${missing.join(', ')}`);
  }

  return records;
}

/** This gym's active plans (must be queried inside the same transaction). */
async function getActivePlans(client: PoolClient): Promise<ActivePlan[]> {
  const r = await client.query<ActivePlan>(
    `SELECT name, duration_months FROM gym_plans WHERE is_active = true ORDER BY created_at`,
  );
  return r.rows;
}

/**
 * Validates every row, then inserts all valid rows for this gym in a single
 * INSERT statement (one transaction via `withTenant`). Rows that fail
 * validation, duplicate a phone number elsewhere in the file, or duplicate
 * an existing member's phone number are skipped and reported individually
 * — partial success is the expected outcome for a 200+ row notebook.
 */
export async function bulkImportMembers(gymId: string, records: Record<string, string>[]): Promise<BulkImportReport> {
  return withTenant(gymId, async (client) => {
    const activePlans = await getActivePlans(client);
    const activePlanNames = activePlans.map((p) => p.name);
    const planDurations = new Map(activePlans.map((p) => [p.name, p.duration_months]));
    const rowSchema = createBulkImportRowSchema(activePlanNames);
    const today = todayIST();

    const errors: BulkImportRowError[] = [];
    const candidates: { row: number; record: Record<string, string>; phone: string; name: string; plan: string; paymentDate: string }[] = [];

    records.forEach((record, idx) => {
      const row = idx + 2; // +1 for 0-index, +1 for the header row
      const parsed = rowSchema.safeParse(record);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const reason = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid row';
        errors.push({ row, data: record, reason });
        return;
      }
      candidates.push({
        row,
        record,
        phone: parsed.data.phone,
        name: parsed.data.name,
        plan: parsed.data.plan,
        paymentDate: parsed.data.payment_date,
      });
    });

    // De-dupe phone numbers within the file — first occurrence wins. A
    // single multi-row INSERT with ON CONFLICT DO NOTHING would error if
    // the same conflict target appears twice in one statement, so this has
    // to happen before the insert rather than rely on the DB.
    const seenPhones = new Map<string, number>();
    const deduped = candidates.filter((c) => {
      const firstRow = seenPhones.get(c.phone);
      if (firstRow !== undefined) {
        errors.push({ row: c.row, data: c.record, reason: `phone: Duplicate of row ${firstRow} in this file` });
        return false;
      }
      seenPhones.set(c.phone, c.row);
      return true;
    });

    // Skip rows whose phone number already belongs to an existing member.
    let toInsert = deduped;
    if (deduped.length > 0) {
      const existingR = await client.query<{ phone: string }>(
        `SELECT phone FROM members WHERE phone = ANY($1::text[])`,
        [deduped.map((c) => c.phone)],
      );
      const existingPhones = new Set(existingR.rows.map((r) => r.phone));
      toInsert = deduped.filter((c) => {
        if (existingPhones.has(c.phone)) {
          errors.push({ row: c.row, data: c.record, reason: 'phone: A member with this phone number already exists' });
          return false;
        }
        return true;
      });
    }

    let imported = 0;
    if (toInsert.length > 0) {
      const values: string[] = [];
      const params: unknown[] = [];
      toInsert.forEach((c, i) => {
        const duration = planDurations.get(c.plan) ?? PLAN_DURATION_MONTHS;
        const expiryDate = addCalendarMonths(c.paymentDate, duration);
        const paymentStatus = expiryDate >= today ? 'PAID' : 'UNPAID';
        const base = i * 7;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
        params.push(gymId, c.name, c.phone, c.plan, c.paymentDate, expiryDate, paymentStatus);
      });

      const r = await client.query(
        `INSERT INTO members (gym_id, name, phone, plan, payment_date, expiry_date, payment_status)
         VALUES ${values.join(', ')}`,
        params,
      );
      imported = r.rowCount ?? 0;
    }

    return { imported, skipped: errors.length, errors };
  });
}

export const BULK_IMPORT_TEMPLATE_CSV = `name,phone,plan,payment_date
Aarav Sharma,9876543210,Standard,2026-06-01
Priya Iyer,9123456789,Weight Loss,2026-06-05
`;
