import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';

import { unscoped, withTenant } from '../db/pool.js';
import { env } from '../config/env.js';
import { todayIST } from '../services/dates.js';
import { sendWhatsApp } from '../services/whatsapp.js';
import { runOwnerSummaries } from '../services/runOwnerSummaries.js';

// Send at exactly 1 day and 2 days before expiry.
const REMINDER_DAYS = [1, 2] as const;

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

interface GymRow {
  gym_id: string;
  gym_name: string;
  sms_credits: number;
  sms_frozen: boolean;
}

interface MemberReminderRow {
  id: string;
  name: string;
  phone: string;
  expiry_date: string;
}

export async function runDailyReminders(log: FastifyBaseLogger): Promise<void> {
  const today = todayIST();
  const targetDates = REMINDER_DAYS.map((d) => addDays(today, d));

  let gyms: GymRow[];
  try {
    const r = await unscoped<GymRow>('SELECT * FROM list_gyms_for_reminders()');
    gyms = r.rows;
  } catch (err) {
    log.error({ err }, 'reminders: failed to list gyms — aborting run');
    return;
  }

  log.info({ gymCount: gyms.length, targetDates }, 'reminders: starting run');

  for (const gym of gyms) {
    // ── Credits guardrail ──────────────────────────────────────────────────
    if (gym.sms_frozen) {
      log.warn({ gymId: gym.gym_id }, 'reminders: gym sms_frozen, skipping');
      continue;
    }
    if (gym.sms_credits <= 0) {
      log.warn({ gymId: gym.gym_id }, 'reminders: 0 credits — freezing gym');
      try {
        await withTenant(gym.gym_id, async (client) => {
          await client.query(
            `UPDATE gyms SET sms_frozen = true
             WHERE id = current_setting('app.current_gym_id')::uuid`,
          );
        });
      } catch (err) {
        log.error({ err, gymId: gym.gym_id }, 'reminders: freeze update failed');
      }
      continue;
    }

    // ── Fetch expiring members ─────────────────────────────────────────────
    let members: MemberReminderRow[];
    try {
      members = await withTenant(gym.gym_id, async (client) => {
        const r = await client.query<MemberReminderRow>(
          `SELECT id, name, phone, expiry_date
           FROM members
           WHERE expiry_date = ANY($1::date[])`,
          [targetDates],
        );
        return r.rows;
      });
    } catch (err) {
      log.error({ err, gymId: gym.gym_id }, 'reminders: member query failed');
      continue;
    }

    for (const member of members) {
      // ── Late-payment safety check ────────────────────────────────────────
      // Re-fetch expiry_date right before sending — member may have renewed
      // in the minutes since we pulled the list.
      let currentExpiry: string | null = null;
      try {
        currentExpiry = await withTenant(gym.gym_id, async (client) => {
          const r = await client.query<{ expiry_date: string }>(
            'SELECT expiry_date FROM members WHERE id = $1',
            [member.id],
          );
          return r.rows[0]?.expiry_date ?? null;
        });
      } catch {
        log.warn({ memberId: member.id }, 'reminders: could not verify expiry — skipping');
        continue;
      }

      if (currentExpiry !== null && !targetDates.includes(currentExpiry)) {
        log.info(
          { memberId: member.id, currentExpiry },
          'reminders: member renewed since list was fetched — skipping',
        );
        continue;
      }

      const idx = targetDates.indexOf(member.expiry_date);
      const daysLeft = REMINDER_DAYS[idx] ?? 1;

      let msgId: string | undefined;
      let errorText: string | undefined;
      let status = 'FAILED';

      // ── Send ──────────────────────────────────────────────────────────────
      try {
        msgId = await sendWhatsApp(member.phone, member.name, gym.gym_name, daysLeft);
        status = 'SENT';
        log.info({ memberId: member.id, gymId: gym.gym_id, daysLeft, msgId }, 'reminder sent');
      } catch (err) {
        errorText = err instanceof Error ? err.message : String(err);
        log.error({ err, memberId: member.id }, 'reminders: sendWhatsApp failed');
      }

      // ── Log + credits ──────────────────────────────────────────────────────
      try {
        await withTenant(gym.gym_id, async (client) => {
          await client.query(
            `INSERT INTO message_log
               (gym_id, member_id, template, status, provider_message_id, error_text, sent_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              gym.gym_id,
              member.id,
              env.AISENSY_CAMPAIGN_NAME ?? 'MembershipExpiryReminder',
              status,
              msgId ?? null,
              errorText ?? null,
              status === 'SENT' ? new Date() : null,
            ],
          );
          if (status === 'SENT') {
            // Decrement credit; freeze the gym if it just hit 0.
            await client.query(
              `UPDATE gyms
               SET sms_credits = GREATEST(sms_credits - 1, 0),
                   sms_frozen  = (sms_credits - 1 <= 0)
               WHERE id = current_setting('app.current_gym_id')::uuid`,
            );
          }
        });
      } catch (err) {
        log.error({ err, memberId: member.id }, 'reminders: post-send log/credit update failed');
      }
    }
  }

  log.info('reminders: run complete');
}

/**
 * Schedule both daily crons. Completely independent — one does not affect
 * the other; both start at server boot.
 *
 * 1. Member expiry reminders  → 08:00 IST = 02:30 UTC
 * 2. Owner daily summary      → 04:00 AM IST = 22:30 UTC (previous calendar day)
 */
export function startDailyCron(log: FastifyBaseLogger): void {
  // ── Member reminder: 08:00 IST (02:30 UTC) ──────────────────────────────
  cron.schedule(
    '30 2 * * *',
    () => {
      void runDailyReminders(log);
    },
    { timezone: 'UTC' },
  );
  log.info('reminders: member-reminder cron scheduled — fires daily at 08:00 IST (02:30 UTC)');

  // ── Owner daily summary: 04:00 AM IST (22:30 UTC previous day) ──────────
  cron.schedule(
    '30 22 * * *',
    () => {
      void runOwnerSummaries(log);
    },
    { timezone: 'UTC' },
  );
  log.info('reminders: owner-summary cron scheduled — fires daily at 04:00 AM IST (22:30 UTC)');
}
