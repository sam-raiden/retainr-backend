import type { FastifyBaseLogger } from 'fastify';
import { unscoped } from '../db/pool.js';
import { sendGymOwnerSummary } from './ownerSummary.js';

interface GymSummaryRow {
  gym_id: string;
  gym_name: string;
  owner_phone: string;
  sms_credits: number;
  sms_frozen: boolean;
  owner_summary_enabled: boolean;
}

/** 500 ms between gyms — avoids hitting AiSensy rate limits. */
const INTER_GYM_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the daily owner summary for every eligible gym.
 *
 * Eligible = owner_summary_enabled AND owner_phone set AND sms_frozen = false.
 * Uses list_gyms_for_owner_summary() (SECURITY DEFINER) so RLS is not an
 * obstacle when listing cross-gym data at cron time.
 */
export async function runOwnerSummaries(log: FastifyBaseLogger): Promise<void> {
  let gyms: GymSummaryRow[];
  try {
    const r = await unscoped<GymSummaryRow>('SELECT * FROM list_gyms_for_owner_summary()');
    gyms = r.rows;
  } catch (err) {
    log.error({ err }, 'owner-summary: failed to list gyms — aborting run');
    return;
  }

  log.info({ gymCount: gyms.length }, 'owner-summary: starting run');

  for (const gym of gyms) {
    if (gym.sms_frozen) {
      log.warn({ gymId: gym.gym_id }, 'owner-summary: sms_frozen — skipping');
      continue;
    }
    if (gym.sms_credits <= 0) {
      log.warn({ gymId: gym.gym_id }, 'owner-summary: 0 credits — skipping');
      continue;
    }

    await sendGymOwnerSummary(gym.gym_id, gym.gym_name, gym.owner_phone, log);
    await sleep(INTER_GYM_DELAY_MS);
  }

  log.info('owner-summary: run complete');
}
