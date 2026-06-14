/**
 * Daily WhatsApp membership-expiry reminder job.
 *
 * Scheduled for 08:00 IST. Iterates every gym (via the SECURITY DEFINER
 * `list_gyms_for_reminders()`, since `unscoped()` alone can't see across
 * tenants), then for each gym uses `withTenant` to find UNPAID members
 * whose membership expires in exactly 1 or 2 days.
 *
 * Single-instance, direct-send — no queue. At our current scale (1-5 gyms,
 * a handful of reminders/day) a synchronous loop that takes a few seconds
 * is fine.
 */
import cron from 'node-cron';

import { unscoped, withTenant } from '../db/pool.js';
import { daysBetween, todayIST } from '../services/dates.js';
import { sendWhatsApp } from '../services/whatsapp.js';

interface GymRow {
  gym_id: string;
  name: string;
  sms_credits: number;
  sms_frozen: boolean;
}

interface MemberRow {
  id: string;
  name: string;
  phone: string;
  expiry_date: string;
  payment_status: string;
}

export interface ReminderRunResult {
  checked_gyms: number;
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Runs the reminder sweep once, synchronously, and returns counts.
 * Used by both the cron schedule and the manual test endpoint.
 */
export async function runDailyReminders(): Promise<ReminderRunResult> {
  const today = todayIST();
  const { rows: gyms } = await unscoped<GymRow>('SELECT * FROM list_gyms_for_reminders()');

  const result: ReminderRunResult = { checked_gyms: 0, candidates: 0, sent: 0, skipped: 0, failed: 0 };

  for (const gym of gyms) {
    result.checked_gyms += 1;
    if (gym.sms_frozen) continue;

    const unpaidMembers = await withTenant(gym.gym_id, async (client) => {
      const r = await client.query<MemberRow>(
        `SELECT id, name, phone, expiry_date, payment_status
         FROM members
         WHERE payment_status = 'UNPAID'`,
      );
      return r.rows;
    });

    let creditsRemaining = gym.sms_credits;
    let frozenFlagged = false;

    for (const member of unpaidMembers) {
      const daysLeft = daysBetween(today, member.expiry_date);
      if (daysLeft !== 1 && daysLeft !== 2) continue;
      result.candidates += 1;

      if (creditsRemaining <= 0) {
        if (!frozenFlagged) {
          await withTenant(gym.gym_id, (client) =>
            client.query('UPDATE gyms SET sms_frozen = true WHERE id = $1', [gym.gym_id]),
          );
          frozenFlagged = true;
        }
        result.skipped += 1;
        continue;
      }

      // Late-payment check — re-confirm UNPAID immediately before sending,
      // in case the member paid in the last few minutes.
      const stillUnpaid = await withTenant(gym.gym_id, async (client) => {
        const r = await client.query<{ payment_status: string }>(
          'SELECT payment_status FROM members WHERE id = $1',
          [member.id],
        );
        return r.rows[0]?.payment_status === 'UNPAID';
      });
      if (!stillUnpaid) {
        result.skipped += 1;
        continue;
      }

      const sendResult = await sendWhatsApp(gym.gym_id, member.id, member.phone, member.name, gym.name, daysLeft);
      if (sendResult.success) {
        result.sent += 1;
        creditsRemaining -= 1;
        await withTenant(gym.gym_id, (client) =>
          client.query('UPDATE gyms SET sms_credits = sms_credits - 1 WHERE id = $1', [gym.gym_id]),
        );
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}

/** Schedules runDailyReminders() for 08:00 IST, every day. */
export function startDailyRemindersCron(): void {
  cron.schedule(
    '0 8 * * *',
    () => {
      runDailyReminders().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[dailyReminders] run failed:', err);
      });
    },
    { timezone: 'Asia/Kolkata' },
  );
}
