import type { FastifyBaseLogger } from 'fastify';
import { withTenant } from '../db/pool.js';
import { env } from '../config/env.js';
import { todayIST } from './dates.js';

interface MemberRow {
  name: string;
  phone: string;
  plan: string;
  price: number | null;
  expiry_date: string; // date string from pg, e.g. "2026-06-24"
}

function memberLine(m: MemberRow): string {
  return `${m.name} - Rs.${m.price ?? '?'} - ${m.phone}`;
}

function formatDateLabel(isoDate: string): string {
  // "2026-06-24" → "Wednesday, 24 June 2026"
  const [y, mo, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

async function sendSummaryMessage(
  ownerPhone: string,
  gymName: string,
  expiringToday: MemberRow[],
  alreadyExpired: MemberRow[],
  todayLabel: string,
): Promise<string> {
  if (!env.AISENSY_API_KEY) throw new Error('AISENSY_API_KEY not configured');

  // Normalise phone: strip non-digits, strip leading 0, prefix 91
  const digits = ownerPhone.replace(/\D/g, '').replace(/^0+/, '');
  const destination = digits.startsWith('91') ? digits : `91${digits}`;

  const isAllClear = expiringToday.length === 0 && alreadyExpired.length === 0;

  const campaignName = isAllClear
    ? (env.AISENSY_OWNER_SUMMARY_CLEAR_CAMPAIGN ?? 'gym_owner_summary_clear')
    : (env.AISENSY_OWNER_SUMMARY_CAMPAIGN        ?? 'gym_owner_summary');

  const templateParams: string[] = isAllClear
    ? [gymName, todayLabel]
    : [
        gymName,
        todayLabel,
        String(expiringToday.length),
        expiringToday.length > 0
          ? expiringToday.map(memberLine).join('\n')
          : 'None today',
        String(alreadyExpired.length),
        alreadyExpired.length > 0
          ? alreadyExpired.map(memberLine).join('\n')
          : 'None',
      ];

  const payload = {
    apiKey: env.AISENSY_API_KEY,
    campaignName,
    destination,
    userName: gymName,
    templateParams,
    source: 'retainr-owner-summary',
    media: {},
    buttons: [],
    carouselCards: [],
  };

  const res = await fetch(
    env.AISENSY_API_URL ?? 'https://backend.aisensy.com/campaign/t1/api/v2',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`AiSensy ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { submitted_message_id?: string };
  return json.submitted_message_id ?? 'unknown';
}

/**
 * Build and send the daily owner summary for one gym.
 *
 * Expiring today  → expiry_date = today IST
 * Already expired → expiry_date < today IST
 *
 * Uses gym_owner_summary AiSensy campaign when any members are present;
 * gym_owner_summary_clear when everything is up to date.
 * Always logs to message_log with message_type = 'OWNER_SUMMARY'.
 */
export async function sendGymOwnerSummary(
  gymId: string,
  gymName: string,
  ownerPhone: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const today    = todayIST();
  const todayLabel = formatDateLabel(today);

  // ── Fetch all members expiring on or before today ────────────────────────
  let expiringToday: MemberRow[] = [];
  let alreadyExpired: MemberRow[] = [];

  try {
    const rows = await withTenant(gymId, async (client) => {
      const r = await client.query<MemberRow>(
        `SELECT m.name, m.phone, m.plan,
                gp.price,
                m.expiry_date::text AS expiry_date
         FROM members m
         LEFT JOIN gym_plans gp
           ON gp.gym_id = current_setting('app.current_gym_id', true)::uuid
          AND gp.name   = m.plan
          AND gp.is_active = true
         WHERE m.expiry_date <= $1::date
         ORDER BY m.expiry_date ASC, m.name ASC`,
        [today],
      );
      return r.rows;
    });

    expiringToday  = rows.filter((m) => m.expiry_date.slice(0, 10) === today);
    alreadyExpired = rows.filter((m) => m.expiry_date.slice(0, 10) <  today);
  } catch (err) {
    log.error({ err, gymId }, 'owner-summary: member query failed — skipping gym');
    return;
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  let msgId: string | undefined;
  let errorText: string | undefined;
  let status = 'FAILED';

  try {
    msgId  = await sendSummaryMessage(ownerPhone, gymName, expiringToday, alreadyExpired, todayLabel);
    status = 'SENT';
    log.info(
      { gymId, gymName, expiringToday: expiringToday.length, alreadyExpired: alreadyExpired.length, msgId },
      'owner-summary: sent',
    );
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
    log.error({ err, gymId }, 'owner-summary: send failed');
  }

  // ── Log + decrement credit ────────────────────────────────────────────────
  try {
    await withTenant(gymId, async (client) => {
      await client.query(
        `INSERT INTO message_log
           (gym_id, member_id, template, status,
            provider_message_id, error_text, sent_at, message_type)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, 'OWNER_SUMMARY')`,
        [
          gymId,
          env.AISENSY_OWNER_SUMMARY_CAMPAIGN ?? 'gym_owner_summary',
          status,
          msgId  ?? null,
          errorText ?? null,
          status === 'SENT' ? new Date() : null,
        ],
      );
      if (status === 'SENT') {
        await client.query(
          `UPDATE gyms
           SET sms_credits = GREATEST(sms_credits - 1, 0),
               sms_frozen  = (sms_credits - 1 <= 0)
           WHERE id = current_setting('app.current_gym_id', true)::uuid`,
        );
      }
    });
  } catch (err) {
    log.error({ err, gymId }, 'owner-summary: log/credit update failed');
  }
}
