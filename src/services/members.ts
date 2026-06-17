import type { PoolClient } from 'pg';

import { withTenant } from '../db/pool.js';
import { NotFoundError } from '../utils/errors.js';
import type { MemberCreateInput, MemberRenewInput, MemberUpdateInput } from '../schemas/member.js';
import {
  PLAN_DURATION_MONTHS,
  addCalendarMonths,
  getDaysRemaining,
  getStatus,
  toISTDateString,
  todayIST,
  type MemberStatus,
} from './dates.js';

interface MemberRow {
  id: string;
  name: string;
  phone: string;
  photo_url: string | null;
  plan: string;
  payment_date: string;
  expiry_date: string;
  payment_status: string;
  created_at: Date;
}

export interface MemberView {
  id: string;
  name: string;
  phone: string;
  photo_url: string | null;
  plan: string;
  plan_price: number;
  plan_duration_months: number;
  payment_date: string;
  expiry_date: string;
  payment_status: string;
  joined_on: string;
  status: MemberStatus;
  days_remaining: number;
}

const MEMBER_COLUMNS =
  'id, name, phone, photo_url, plan, payment_date, expiry_date, payment_status, created_at';

interface PlanInfo {
  price: number;
  duration_months: number;
}

/** name -> {price, duration_months} for every plan this gym has ever had (active or not). */
async function getPlanMap(client: PoolClient): Promise<Map<string, PlanInfo>> {
  const r = await client.query<{ name: string; price: number; duration_months: number }>(
    'SELECT name, price, duration_months FROM gym_plans',
  );
  return new Map(r.rows.map((p) => [p.name, { price: p.price, duration_months: p.duration_months }]));
}

function planDuration(planMap: Map<string, PlanInfo>, plan: string): number {
  return planMap.get(plan)?.duration_months ?? PLAN_DURATION_MONTHS;
}

function decorate(row: MemberRow, planMap: Map<string, PlanInfo>, today: string): MemberView {
  const plan = planMap.get(row.plan);
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    photo_url: row.photo_url,
    plan: row.plan,
    plan_price: plan?.price ?? 0,
    plan_duration_months: plan?.duration_months ?? PLAN_DURATION_MONTHS,
    payment_date: row.payment_date,
    expiry_date: row.expiry_date,
    payment_status: row.payment_status,
    joined_on: toISTDateString(row.created_at),
    status: getStatus(row.expiry_date, today),
    days_remaining: getDaysRemaining(row.expiry_date, today),
  };
}

export async function listMembers(gymId: string): Promise<MemberView[]> {
  return withTenant(gymId, async (client) => {
    const [membersR, planMap] = await Promise.all([
      client.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM members ORDER BY created_at DESC`),
      getPlanMap(client),
    ]);
    const today = todayIST();
    return membersR.rows.map((row) => decorate(row, planMap, today));
  });
}

export interface CreateMemberResult {
  member: MemberView;
  payment: {
    id: string;
    amount: number;
    payment_method: string;
    paid_at: string;
    plan: string;
    note: string | null;
  };
}

export async function createMember(gymId: string, input: MemberCreateInput): Promise<CreateMemberResult> {
  return withTenant(gymId, async (client) => {
    const planMap = await getPlanMap(client);
    const expiryDate = addCalendarMonths(input.payment_date, planDuration(planMap, input.plan));
    const memberR = await client.query<MemberRow>(
      `INSERT INTO members (gym_id, name, phone, photo_url, plan, payment_date, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${MEMBER_COLUMNS}`,
      [gymId, input.name, input.phone, input.photo_url ?? null, input.plan, input.payment_date, expiryDate],
    );
    const member = memberR.rows[0]!;
    const planPrice = planMap.get(input.plan)?.price ?? 0;
    const amount = input.payment_amount ?? planPrice;
    const note = input.note ?? null;
    const paymentR = await client.query<{ id: string; amount: number; payment_method: string; paid_at: Date; note: string | null }>(
      `INSERT INTO payments (gym_id, member_id, amount, payment_method, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, amount, payment_method, paid_at, note`,
      [gymId, member.id, amount, input.payment_method, note],
    );
    const payment = paymentR.rows[0]!;
    return {
      member: decorate(member, planMap, todayIST()),
      payment: {
        id: payment.id,
        amount: payment.amount,
        payment_method: payment.payment_method,
        paid_at: toISTDateString(payment.paid_at),
        plan: input.plan,
        note: payment.note,
      },
    };
  });
}

export async function updateMember(
  gymId: string,
  memberId: string,
  input: MemberUpdateInput,
): Promise<MemberView> {
  return withTenant(gymId, async (client) => {
    const existingR = await client.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = $1`, [
      memberId,
    ]);
    const existing = existingR.rows[0];
    if (!existing) throw new NotFoundError('Member not found');

    const name = input.name ?? existing.name;
    const phone = input.phone ?? existing.phone;
    const plan = input.plan ?? existing.plan;
    const paymentDate = input.payment_date ?? existing.payment_date;
    const photoUrl = input.photo_url !== undefined ? input.photo_url : existing.photo_url;
    const planMap = await getPlanMap(client);
    const expiryDate = addCalendarMonths(paymentDate, planDuration(planMap, plan));

    const r = await client.query<MemberRow>(
      `UPDATE members
       SET name = $1, phone = $2, plan = $3, payment_date = $4, expiry_date = $5, photo_url = $6
       WHERE id = $7
       RETURNING ${MEMBER_COLUMNS}`,
      [name, phone, plan, paymentDate, expiryDate, photoUrl, memberId],
    );
    return decorate(r.rows[0]!, planMap, todayIST());
  });
}

export async function setMemberPhoto(gymId: string, memberId: string, photoUrl: string): Promise<MemberView> {
  return withTenant(gymId, async (client) => {
    const r = await client.query<MemberRow>(
      `UPDATE members SET photo_url = $1 WHERE id = $2 RETURNING ${MEMBER_COLUMNS}`,
      [photoUrl, memberId],
    );
    if (r.rowCount === 0) throw new NotFoundError('Member not found');
    const planMap = await getPlanMap(client);
    return decorate(r.rows[0]!, planMap, todayIST());
  });
}

export async function deleteMember(gymId: string, memberId: string): Promise<void> {
  return withTenant(gymId, async (client) => {
    const r = await client.query('DELETE FROM members WHERE id = $1 RETURNING id', [memberId]);
    if (r.rowCount === 0) throw new NotFoundError('Member not found');
  });
}

export interface RenewResult {
  member: MemberView;
  payment: {
    id: string;
    amount: number;
    payment_method: string;
    paid_at: string;
    plan: string;
    note: string | null;
  };
  previous: {
    payment_date: string;
    plan: string;
  };
}

/**
 * Renews a member for another cycle starting today: bumps payment_date to
 * today, recomputes expiry_date, optionally switches plan, and logs a
 * payment row. Returns the previous payment_date/plan so the frontend can
 * offer an undo (revert via PATCH + DELETE the payment).
 */
export async function renewMember(
  gymId: string,
  memberId: string,
  input: MemberRenewInput,
): Promise<RenewResult> {
  return withTenant(gymId, async (client) => {
    const existingR = await client.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = $1`, [
      memberId,
    ]);
    const existing = existingR.rows[0];
    if (!existing) throw new NotFoundError('Member not found');

    const plan = input.plan ?? existing.plan;
    const today = todayIST();
    const planMap = await getPlanMap(client);
    const expiryDate = addCalendarMonths(today, planDuration(planMap, plan));
    const planPrice = planMap.get(plan)?.price ?? 0;
    const amount = input.payment_amount ?? planPrice;
    const note = input.note ?? null;

    const memberR = await client.query<MemberRow>(
      `UPDATE members SET plan = $1, payment_date = $2, expiry_date = $3
       WHERE id = $4
       RETURNING ${MEMBER_COLUMNS}`,
      [plan, today, expiryDate, memberId],
    );

    const paymentR = await client.query<{ id: string; amount: number; payment_method: string; paid_at: Date; note: string | null }>(
      `INSERT INTO payments (gym_id, member_id, amount, payment_method, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, amount, payment_method, paid_at, note`,
      [gymId, memberId, amount, input.payment_method, note],
    );
    const payment = paymentR.rows[0]!;

    return {
      member: decorate(memberR.rows[0]!, planMap, today),
      payment: {
        id: payment.id,
        amount: payment.amount,
        payment_method: payment.payment_method,
        paid_at: toISTDateString(payment.paid_at),
        plan,
        note: payment.note,
      },
      previous: {
        payment_date: existing.payment_date,
        plan: existing.plan,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardView {
  stats: {
    total: number;
    active: number;
    expiring: number;
    expired: number;
    revenue: number;
  };
  expiring_this_week: MemberView[];
  sms_credits: number;
  sms_frozen: boolean;
}

export async function getDashboard(gymId: string): Promise<DashboardView> {
  return withTenant(gymId, async (client) => {
    const [membersR, planMap, paymentsR, gymR] = await Promise.all([
      client.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM members`),
      getPlanMap(client),
      client.query<{ amount: number; paid_at: Date }>('SELECT amount, paid_at FROM payments'),
      client.query<{ sms_credits: number; sms_frozen: boolean }>(
        `SELECT sms_credits, sms_frozen FROM gyms
         WHERE id = current_setting('app.current_gym_id')::uuid`,
      ),
    ]);

    const today = todayIST();
    const decorated = membersR.rows.map((row) => decorate(row, planMap, today));

    let active = 0;
    let expiring = 0;
    let expired = 0;
    for (const m of decorated) {
      if (m.status === 'active') active += 1;
      else if (m.status === 'expiring') expiring += 1;
      else expired += 1;
    }

    const currentMonth = today.slice(0, 7);
    const revenue = paymentsR.rows
      .filter((p) => toISTDateString(p.paid_at).startsWith(currentMonth))
      .reduce((sum, p) => sum + p.amount, 0);

    const expiringThisWeek = decorated
      .filter((m) => m.status === 'expiring')
      .sort((a, b) => a.days_remaining - b.days_remaining);

    const gym = gymR.rows[0];

    return {
      stats: { total: decorated.length, active, expiring, expired, revenue },
      expiring_this_week: expiringThisWeek,
      sms_credits: gym?.sms_credits ?? 0,
      sms_frozen: gym?.sms_frozen ?? false,
    };
  });
}
