import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';

import { pool, unscoped, withTenant } from '../db/pool.js';
import { todayIST } from '../services/dates.js';
import { sendWhatsApp } from '../services/whatsapp.js';

// Remind at exactly 1, 3, and 7 days before expiry.
const REMINDER_DAYS = [1, 3, 7] as const;

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

interface GymRow {
  gym_id: string;
  gym_name: string;
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
    try {
      const members = await withTenant(gym.gym_id, async (client) => {
        const r = await client.query<MemberReminderRow>(
          `SELECT id, name, phone, expiry_date
           FROM members
           WHERE expiry_date = ANY($1::date[])`,
          [targetDates],
        );
        return r.rows;
      });

      for (const member of members) {
        const idx = targetDates.indexOf(member.expiry_date);
        const daysLeft = REMINDER_DAYS[idx] ?? 0;
        try {
          await sendWhatsApp(member.phone, member.name, gym.gym_name, daysLeft);
          log.info(
            { memberId: member.id, gymId: gym.gym_id, daysLeft },
            'reminder sent',
          );
        } catch (err) {
          log.error(
            { err, memberId: member.id, gymId: gym.gym_id },
            'reminder: sendWhatsApp failed',
          );
        }
      }
    } catch (err) {
      log.error({ err, gymId: gym.gym_id }, 'reminders: per-gym query failed');
    }
  }

  log.info('reminders: run complete');
}

/**
 * Schedule the daily reminder cron.
 * Fires at 09:00 IST = 03:30 UTC every day.
 */
export function startDailyCron(log: FastifyBaseLogger): void {
  cron.schedule(
    '30 3 * * *',
    () => {
      void runDailyReminders(log);
    },
    { timezone: 'UTC' },
  );
  log.info('reminders: cron scheduled — fires daily at 09:00 IST (03:30 UTC)');
}
