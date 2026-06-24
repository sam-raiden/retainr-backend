import type { FastifyBaseLogger } from 'fastify';
import { withTenant } from '../db/pool.js';
import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { todayIST } from './dates.js';
import { generateDailySummaryImage, type SummaryMember } from './imageGenerator.js';

const DAILY_SUMMARIES_BUCKET = 'daily-summaries';

interface MemberRow extends SummaryMember {
  expiry_date: string;
}

function memberLine(m: MemberRow): string {
  return `${m.name} - Rs.${m.price ?? '?'} - ${m.phone}`;
}

function formatDateLabel(isoDate: string): string {
  const [y, mo, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ── Image generation + upload ────────────────────────────────────────────────

async function uploadSummaryImage(
  gymId: string,
  today: string,
  gymName: string,
  dateLabel: string,
  expiring: MemberRow[],
  expired: MemberRow[],
  log: FastifyBaseLogger,
): Promise<string | null> {
  try {
    const buffer = await generateDailySummaryImage(gymName, dateLabel, expiring, expired);
    const path   = `${gymId}/${today}.png`;

    const { error: uploadErr } = await supabase.storage
      .from(DAILY_SUMMARIES_BUCKET)
      .upload(path, buffer, { contentType: 'image/png', upsert: true });

    if (uploadErr) {
      log.warn({ err: uploadErr.message, gymId }, 'owner-summary: image upload failed');
      return null;
    }

    const { data } = supabase.storage.from(DAILY_SUMMARIES_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    log.warn({ err, gymId }, 'owner-summary: image generation failed — falling back to text');
    return null;
  }
}

// ── AiSensy send (image or text fallback) ────────────────────────────────────

async function sendViaAiSensy(
  ownerPhone: string,
  gymName: string,
  expiring: MemberRow[],
  expired: MemberRow[],
  todayLabel: string,
  imageUrl: string | null,
): Promise<string> {
  if (!env.AISENSY_API_KEY) throw new Error('AISENSY_API_KEY not configured');

  const digits      = ownerPhone.replace(/\D/g, '').replace(/^0+/, '');
  const destination = digits.startsWith('91') ? digits : `91${digits}`;

  let campaignName: string;
  let templateParams: string[];
  let media: object;

  if (imageUrl) {
    // Image template: header media + 2 text params
    campaignName   = env.AISENSY_IMAGE_SUMMARY_CAMPAIGN ?? 'gym_daily_image_update';
    templateParams = [gymName, todayLabel];
    media          = { url: imageUrl, filename: `${gymName}-daily-summary.png` };
  } else {
    // Text fallback
    const isAllClear = expiring.length === 0 && expired.length === 0;
    campaignName   = isAllClear
      ? (env.AISENSY_OWNER_SUMMARY_CLEAR_CAMPAIGN ?? 'gym_owner_summary_clear')
      : (env.AISENSY_OWNER_SUMMARY_CAMPAIGN ?? 'gym_owner_summary');
    templateParams = isAllClear
      ? [gymName, todayLabel]
      : [
          gymName, todayLabel,
          String(expiring.length),
          expiring.length > 0 ? expiring.map(memberLine).join('\n') : 'None today',
          String(expired.length),
          expired.length > 0 ? expired.map(memberLine).join('\n') : 'None',
        ];
    media = {};
  }

  const payload = {
    apiKey: env.AISENSY_API_KEY,
    campaignName,
    destination,
    userName: gymName,
    templateParams,
    source: 'retainr-owner-summary',
    media,
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

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate image summary, upload to Supabase Storage, and send via AiSensy.
 * Falls back to text message if image generation or upload fails.
 * Always logs to message_log with message_type = 'OWNER_SUMMARY'.
 *
 * Returns the public image URL (or null if fallback to text was used).
 */
export async function sendGymOwnerSummary(
  gymId: string,
  gymName: string,
  ownerPhone: string,
  log: FastifyBaseLogger,
): Promise<string | null> {
  const today      = todayIST();
  const todayLabel = formatDateLabel(today);

  // ── 1. Fetch expiring / expired members ──────────────────────────────────
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
    alreadyExpired = rows.filter((m) => m.expiry_date.slice(0, 10) < today);
  } catch (err) {
    log.error({ err, gymId }, 'owner-summary: member query failed — skipping');
    return null;
  }

  // ── 2. Generate image (best-effort; null = fall back to text) ────────────
  const imageUrl = await uploadSummaryImage(
    gymId, today, gymName, todayLabel, expiringToday, alreadyExpired, log,
  );

  log.info({ gymId, imageUrl: imageUrl ?? '(none — text fallback)', expiringToday: expiringToday.length, alreadyExpired: alreadyExpired.length }, 'owner-summary: image ready');

  // ── 3. Send via AiSensy ───────────────────────────────────────────────────
  let msgId: string | undefined;
  let errorText: string | undefined;
  let status = 'FAILED';

  try {
    msgId  = await sendViaAiSensy(ownerPhone, gymName, expiringToday, alreadyExpired, todayLabel, imageUrl);
    status = 'SENT';
    log.info({ gymId, gymName, msgId, usedImage: imageUrl !== null }, 'owner-summary: sent');
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
    log.error({ err, gymId }, 'owner-summary: send failed');
  }

  // ── 4. Log to message_log + decrement credit ─────────────────────────────
  try {
    await withTenant(gymId, async (client) => {
      await client.query(
        `INSERT INTO message_log
           (gym_id, member_id, template, status,
            provider_message_id, error_text, sent_at, message_type)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, 'OWNER_SUMMARY')`,
        [
          gymId,
          env.AISENSY_IMAGE_SUMMARY_CAMPAIGN ?? 'gym_daily_image_update',
          status,
          msgId    ?? null,
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

  return imageUrl;
}
