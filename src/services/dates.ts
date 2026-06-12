/**
 * Date/status math, ported from the frontend's src/utils/memberUtils.js so
 * the backend computes the same "today", end dates, and status thresholds.
 *
 * Every "today" in this app is the calendar date in IST (Asia/Kolkata),
 * regardless of where the server runs. All membership dates are
 * YYYY-MM-DD strings — never Date objects — to avoid timezone drift.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Fallback cycle length when a member's plan can't be found in gym_plans
// (e.g. it was deleted between requests). Every plan also carries its own
// duration_months, which callers should prefer.
export const PLAN_DURATION_MONTHS = 1;

export type MemberStatus = 'active' | 'expiring' | 'expired';

/** Format a Date (any instant) as its calendar date in IST. */
export function toISTDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "Today" as a YYYY-MM-DD string in IST. */
export function todayIST(): string {
  return toISTDateString(new Date());
}

function parseISO(iso: string): { y: number; m: number; d: number } {
  const parts = iso.split('-').map(Number);
  return { y: parts[0]!, m: parts[1]!, d: parts[2]! };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

// month1 is 1-indexed (1 = Jan). Day 0 of "next" month = last day of given month.
function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Add N calendar months, clamping to the target month's last day if the
 * original day doesn't exist there (e.g. Jan 31 + 1 month = Feb 28/29).
 */
export function addCalendarMonths(iso: string, months: number): string {
  if (!months || months <= 0) return iso;
  const { y, m, d } = parseISO(iso);
  const totalMonthIdx = m - 1 + months;
  const targetYear = y + Math.floor(totalMonthIdx / 12);
  const targetMonth = (totalMonthIdx % 12) + 1;
  const day = Math.min(d, lastDayOfMonth(targetYear, targetMonth));
  return formatYMD(targetYear, targetMonth, day);
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = parseISO(fromISO);
  const b = parseISO(toISO);
  return Math.round(
    (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / MS_PER_DAY,
  );
}

/** End of the membership cycle = payment date + the plan's duration. */
export function computeEndDate(paymentDateISO: string, months = PLAN_DURATION_MONTHS): string {
  return addCalendarMonths(paymentDateISO, months);
}

export function getStatus(endDateISO: string, today: string = todayIST()): MemberStatus {
  const days = daysBetween(today, endDateISO);
  if (days < 0) return 'expired';
  if (days <= 7) return 'expiring';
  return 'active';
}

export function getDaysRemaining(endDateISO: string, today: string = todayIST()): number {
  return daysBetween(today, endDateISO);
}

/** True if `iso` is a real calendar date in YYYY-MM-DD form (rejects e.g. 2025-02-30). */
export function isValidCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  return d >= 1 && d <= lastDayOfMonth(y, mo);
}
