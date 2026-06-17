import { withTenant } from '../db/pool.js';
import { NotFoundError } from '../utils/errors.js';
import { toISTDateString } from './dates.js';

export interface PaymentView {
  id: string;
  member_id: string;
  member_name: string;
  photo_url: string | null;
  plan: string;
  amount: number;
  payment_method: string | null;
  paid_at: string;
  note: string | null;
}

interface PaymentRow {
  id: string;
  member_id: string;
  member_name: string;
  photo_url: string | null;
  plan: string;
  amount: number;
  payment_method: string | null;
  paid_at: Date;
  note: string | null;
}

function toView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    member_id: row.member_id,
    member_name: row.member_name,
    photo_url: row.photo_url,
    plan: row.plan,
    amount: row.amount,
    payment_method: row.payment_method,
    paid_at: toISTDateString(row.paid_at),
    note: row.note,
  };
}

/**
 * All payments for the gym, newest first. `plan` reflects the member's
 * *current* plan — payments don't snapshot the plan they were made under,
 * so a later plan switch will retroactively relabel older payment rows.
 */
export async function listPayments(gymId: string): Promise<PaymentView[]> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<PaymentRow>(
      `SELECT p.id, p.member_id, m.name AS member_name, m.photo_url, m.plan,
              p.amount, p.payment_method, p.paid_at, p.note
       FROM payments p
       JOIN members m ON m.id = p.member_id
       ORDER BY p.paid_at DESC`,
    );
    return r.rows.map(toView);
  });
}

/** All payments for a single member, newest first. */
export async function listMemberPayments(gymId: string, memberId: string): Promise<PaymentView[]> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<PaymentRow>(
      `SELECT p.id, p.member_id, m.name AS member_name, m.photo_url, m.plan,
              p.amount, p.payment_method, p.paid_at, p.note
       FROM payments p
       JOIN members m ON m.id = p.member_id
       WHERE p.member_id = $1
       ORDER BY p.paid_at DESC`,
      [memberId],
    );
    return r.rows.map(toView);
  });
}

/** Used to undo a renewal — deletes the payment row the renewal created. */
export async function deletePayment(gymId: string, paymentId: string): Promise<void> {
  return withTenant(gymId, async (client) => {
    const r = await client.query('DELETE FROM payments WHERE id = $1 RETURNING id', [paymentId]);
    if (r.rowCount === 0) throw new NotFoundError('Payment not found');
  });
}
