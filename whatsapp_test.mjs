/**
 * Test 7 — WhatsApp reminder live test using Sam (real phone in production gym).
 *
 * 1. Records Sam's current expiry_date
 * 2. Sets expiry_date to today+1 (so cron finds him)
 * 3. Records sms_credits BEFORE
 * 4. Runs runDailyReminders()
 * 5. Checks message_log for Sam
 * 6. Records sms_credits AFTER
 * 7. Resets Sam's expiry_date to original
 */
import 'dotenv/config';
import pg from 'pg';
import pino from 'pino';
import { runDailyReminders } from './src/cron/dailyReminders.js';

const GYM_ID = 'cc90d9b1-587b-4102-b79f-3edc2eb22d98';  // production Kai Green Fitness
const SAM_ID = 'a137d24e-8b7c-4bf9-8e19-bef396733059';

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const tomorrow = addDays(todayIST(), 1);

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});
await client.connect();

// ── 1. Read Sam's original expiry ──────────────────────────────────────────
const orig = await client.query(
  `SELECT expiry_date FROM members WHERE id = $1`, [SAM_ID]
);
const rawExpiry = orig.rows[0]?.expiry_date;
const originalExpiry = typeof rawExpiry === 'string' ? rawExpiry.slice(0,10)
  : rawExpiry instanceof Date ? rawExpiry.toISOString().slice(0,10) : String(rawExpiry).slice(0,10);
console.log('Sam original expiry_date:', originalExpiry);

// ── 2. Set expiry to today+1 ───────────────────────────────────────────────
await client.query(
  `UPDATE members SET expiry_date = $1 WHERE id = $2`, [tomorrow, SAM_ID]
);
console.log('Set Sam expiry_date to:', tomorrow, '(today+1)');

// ── 3. sms_credits BEFORE ─────────────────────────────────────────────────
const before = await client.query(
  `SELECT sms_credits FROM gyms WHERE id = $1`, [GYM_ID]
);
const creditsBefore = before.rows[0].sms_credits;
console.log('sms_credits BEFORE:', creditsBefore);

// ── 4. Run cron ───────────────────────────────────────────────────────────
const log = pino({ level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
});
console.log('\n─── runDailyReminders() ─────────────────────────────────────\n');
await runDailyReminders(log);
console.log('\n─── done ────────────────────────────────────────────────────\n');

// ── 5. message_log ────────────────────────────────────────────────────────
const logRows = await client.query(
  `SELECT template, status, provider_message_id, error_text,
          sent_at AT TIME ZONE 'Asia/Kolkata' AS sent_ist
   FROM message_log
   WHERE member_id = $1
   ORDER BY created_at DESC LIMIT 3`,
  [SAM_ID]
);
console.log('message_log rows for Sam:');
if (logRows.rowCount === 0) {
  console.log('  ⚠️  NO ROWS');
} else {
  console.table(logRows.rows);
}

// ── 6. sms_credits AFTER ─────────────────────────────────────────────────
const after = await client.query(
  `SELECT sms_credits FROM gyms WHERE id = $1`, [GYM_ID]
);
const creditsAfter = after.rows[0].sms_credits;
const diff = creditsBefore - creditsAfter;
console.log('sms_credits BEFORE:', creditsBefore);
console.log('sms_credits AFTER: ', creditsAfter);
console.log('Decremented by 1:  ', diff === 1 ? '✅ YES' : `❌ NO (diff=${diff})`);

// ── 7. Reset Sam's expiry ─────────────────────────────────────────────────
await client.query(
  `UPDATE members SET expiry_date = $1 WHERE id = $2`, [originalExpiry, SAM_ID]
);
console.log('\nSam expiry_date restored to:', originalExpiry);

await client.end();
