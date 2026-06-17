import { env } from '../config/env.js';

const ENDPOINT = 'https://backend.aisensy.com/campaign/t1/api/v2';

/**
 * Send a membership-expiry reminder via AiSensy's campaign API.
 *
 * Template params order must match the approved template:
 *   {{1}} = memberName, {{2}} = gymName, {{3}} = daysLeft
 *
 * Phone must be a 10-digit Indian mobile number or a 12-digit "91XXXXXXXXXX"
 * string — either form is normalised to the E.164 destination AiSensy expects.
 */
export async function sendWhatsApp(
  phone: string,
  memberName: string,
  gymName: string,
  daysLeft: number,
): Promise<void> {
  if (!env.AISENSY_API_KEY || !env.AISENSY_CAMPAIGN_NAME) {
    throw new Error('AISENSY_API_KEY / AISENSY_CAMPAIGN_NAME not set');
  }

  const digits = phone.replace(/\D/g, '');
  const destination =
    digits.length === 12 && digits.startsWith('91') ? digits : `91${digits}`;

  const payload = {
    apiKey: env.AISENSY_API_KEY,
    campaignName: env.AISENSY_CAMPAIGN_NAME,
    destination,
    userName: gymName,
    templateParams: [memberName, gymName, daysLeft.toString()],
    source: 'retainr-cron',
    media: {},
    buttons: [],
    carouselCards: [],
  };

  const res = await fetch(env.AISENSY_API_URL ?? ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`AiSensy ${res.status}: ${text}`);
  }
}
