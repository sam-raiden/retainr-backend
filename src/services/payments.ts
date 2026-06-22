import { withTenant } from '../db/pool.js';
import { NotFoundError } from '../utils/errors.js';
import { toISTDateString } from './dates.js';
import { batchSignPhotoUrls } from './paymentPhotos.js';

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
  /** Fresh 1-hour signed URL generated at read-time, or null if no photo was taken. */
  approver_photo_url: string | null;
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
  /** Storage path stored in DB, e.g. "{gymId}/payment-approvals/{paymentId}.jpg". Never a signed URL. */
  approver_photo_url: string | null;
}

// signedUrls: path → fresh signed URL, generated once per list call
function toView(row: PaymentRow, signedUrls: Map<string, string>): PaymentView {
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
    approver_photo_url: row.approver_photo_url
      ? (signedUrls.get(row.approver_photo_url) ?? null)
      : null,
  };
}

/**
 * All payments for the gym, newest first.
 * approver_photo_url in the response is a fresh 1-hour signed URL,
 * generated via a single batch Supabase Storage call.
 */
export async function listPayments(gymId: string): Promise<PaymentView[]> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<PaymentRow>(
      `SELECT p.id, p.member_id, m.name AS member_name, m.photo_url, m.plan,
              p.amount, p.payment_method, p.paid_at, p.note, p.approver_photo_url
       FROM payments p
       JOIN members m ON m.id = p.member_id
       ORDER BY p.paid_at DESC`,
    );
    const signedUrls = await batchSignPhotoUrls(r.rows.map((row) => row.approver_photo_url));
    return r.rows.map((row) => toView(row, signedUrls));
  });
}

/** All payments for a single member, newest first. */
export async function listMemberPayments(gymId: string, memberId: string): Promise<PaymentView[]> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<PaymentRow>(
      `SELECT p.id, p.member_id, m.name AS member_name, m.photo_url, m.plan,
              p.amount, p.payment_method, p.paid_at, p.note, p.approver_photo_url
       FROM payments p
       JOIN members m ON m.id = p.member_id
       WHERE p.member_id = $1
       ORDER BY p.paid_at DESC`,
      [memberId],
    );
    const signedUrls = await batchSignPhotoUrls(r.rows.map((row) => row.approver_photo_url));
    return r.rows.map((row) => toView(row, signedUrls));
  });
}

/** Used to undo a renewal — deletes the payment row the renewal created. */
export async function deletePayment(gymId: string, paymentId: string): Promise<void> {
  return withTenant(gymId, async (client) => {
    const r = await client.query('DELETE FROM payments WHERE id = $1 RETURNING id', [paymentId]);
    if (r.rowCount === 0) throw new NotFoundError('Payment not found');
  });
}
