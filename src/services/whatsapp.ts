/**
 * AiSensy WhatsApp Business API client.
 *
 * One template is wired up for now — the membership expiry reminder:
 *   "Hi {{1}}, your membership at {{2}} expires in {{3}} days. Please
 *    clear your dues at the gym counter."
 *
 * Every send (success or failure) is logged to message_log via
 * withTenant(gymId, ...) so RLS scopes the row to the sending gym.
 */
import { withTenant } from '../db/pool.js';
import { env } from '../config/env.js';

export interface WhatsAppResult {
  success: boolean;
  providerMessageId?: string;
  errorText?: string;
}

const REMINDER_TEMPLATE =
  'Hi {{1}}, your membership at {{2}} expires in {{3}} days. Please clear your dues at the gym counter.';

/** AiSensy expects destination numbers as digits-only with country code, no "+". */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function renderTemplate(name: string, gymName: string, daysLeft: number): string {
  return REMINDER_TEMPLATE.replace('{{1}}', name).replace('{{2}}', gymName).replace('{{3}}', String(daysLeft));
}

async function callAiSensy(phone: string, name: string, gymName: string, daysLeft: number): Promise<WhatsAppResult> {
  if (!env.AISENSY_API_URL || !env.AISENSY_API_KEY || !env.AISENSY_CAMPAIGN_NAME) {
    return { success: false, errorText: 'AiSensy is not configured (missing AISENSY_* env vars)' };
  }

  try {
    const res = await fetch(env.AISENSY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: env.AISENSY_API_KEY,
        campaignName: env.AISENSY_CAMPAIGN_NAME,
        destination: normalizePhone(phone),
        userName: gymName,
        templateParams: [name, gymName, String(daysLeft)],
      }),
    });

    const body: unknown = await res.json().catch(() => null);
    const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

    if (res.ok && bodyObj.success !== false) {
      const providerMessageId =
        typeof bodyObj.submitted_message_id === 'string'
          ? bodyObj.submitted_message_id
          : typeof bodyObj.id === 'string'
            ? bodyObj.id
            : undefined;
      return providerMessageId ? { success: true, providerMessageId } : { success: true };
    }

    return { success: false, errorText: JSON.stringify(bodyObj).slice(0, 500) };
  } catch (err) {
    return { success: false, errorText: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Sends the membership expiry reminder template and logs the outcome to
 * message_log. Returns the send result so callers can decide whether to
 * decrement sms_credits.
 */
export async function sendWhatsApp(
  gymId: string,
  memberId: string,
  phone: string,
  name: string,
  gymName: string,
  daysLeft: number,
): Promise<WhatsAppResult> {
  const result = await callAiSensy(phone, name, gymName, daysLeft);
  const template = renderTemplate(name, gymName, daysLeft);

  await withTenant(gymId, async (client) => {
    await client.query(
      `INSERT INTO message_log (gym_id, member_id, template, status, provider_message_id, error_text, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        gymId,
        memberId,
        template,
        result.success ? 'SENT' : 'FAILED',
        result.providerMessageId ?? null,
        result.errorText ?? null,
        result.success ? new Date() : null,
      ],
    );
  });

  return result;
}
