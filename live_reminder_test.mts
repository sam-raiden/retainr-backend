/**
 * Live end-to-end test for the daily reminder cron.
 * Run with: PHONE=9876543210 node_modules/.bin/tsx live_reminder_test.mts
 *
 * 1. Records sms_credits BEFORE for the target gym
 * 2. Inserts a test member (expiry_date = today+2, real phone number)
 * 3. Calls runDailyReminders() — exact same function the cron executes
 * 4. Reads message_log row(s) for this member
 * 5. Records sms_credits AFTER
 * 6. Prints: log row + before/after credits as proof
 * 7. Deletes the test member (cleanup)
 */
import 'dotenv/config';
import pg from 'pg';
import pino from 'pino';
import { runDailyReminders } from './src/cron/dailyReminders.js';
import { todayIST } from './src/services/dates.js';

const PHONE  = process.env.PHONE;
// Demo "Kai Green Fitness" gym — keeps test away from the production gym
const GYM_ID = '63987bf5-efe1-4276-84ac-83c3fd57137d';

if (!PHONE) {
  process.stderr.write('Usage: PHONE=9876543210 node_modules/.bin/tsx live_reminder_test.mts\n');
  process.exit(1);
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const today      = todayIST();
const expiryDate = addDays(today, 2);

console.log('\nTest params:');
console.log(`  GYM    : Kai Green Fitness (demo) ${GYM_ID}`);
console.log(`  PHONE  : ${PHONE}`);
console.log(`  TODAY  : ${today}`);
console.log(`  EXPIRY : ${expiryDate}  (today+2)\n`);

// ── Admin DB client (bypasses RLS for verification reads) ──────────────────
const client = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL,
});
await client.connect();

// ── 1. sms_credits BEFORE ─────────────────────────────────────────────────
const before = await client.query<{ sms_credits: number; sms_frozen: boolean }>(
  `SELECT sms_credits, sms_frozen FROM gyms WHERE id = $1`,
  [GYM_ID],
);
const creditsBefore = before.rows[0]!.sms_credits;
console.log(`sms_credits BEFORE : ${creditsBefore}`);
console.log(`sms_frozen  BEFORE : ${before.rows[0]!.sms_frozen}\n`);

// ── 2. Insert test member (needs RLS context to satisfy FK / policy) ───────
await client.query('BEGIN');
await client.query(`SET LOCAL app.current_gym_id = '${GYM_ID}'`);
await client.query(`SET LOCAL ROLE app_backend`);
const ins = await client.query<{ id: string; name: string; phone: string; expiry_date: string }>(
  `INSERT INTO members (gym_id, name, phone, plan, payment_date, expiry_date)
   VALUES ($1, 'Test Reminder User', $2, 'Standard', $3, $4)
   RETURNING id, name, phone, expiry_date`,
  [GYM_ID, PHONE, today, expiryDate],
);
const member = ins.rows[0]!;
await client.query('COMMIT');

console.log('Test member inserted:');
console.table([member]);

// ── 3. Run the cron function ───────────────────────────────────────────────
const log = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
});

console.log('\n─── runDailyReminders() START ───────────────────────────────────\n');
await runDailyReminders(log);
console.log('\n─── runDailyReminders() DONE ────────────────────────────────────\n');

// ── 4. message_log proof ──────────────────────────────────────────────────
const logRows = await client.query(
  `SELECT id, template, status, provider_message_id, error_text,
          sent_at AT TIME ZONE 'Asia/Kolkata' AS sent_at_IST, created_at
   FROM message_log
   WHERE member_id = $1
   ORDER BY created_at DESC
   LIMIT 5`,
  [member.id],
);
console.log(`message_log rows for member ${member.id}:`);
if (logRows.rows.length === 0) {
  console.log('  ⚠️  NO ROWS — INSERT into message_log did not happen');
} else {
  console.table(logRows.rows);
}

// ── 5. sms_credits AFTER ──────────────────────────────────────────────────
const after = await client.query<{ sms_credits: number; sms_frozen: boolean }>(
  `SELECT sms_credits, sms_frozen FROM gyms WHERE id = $1`,
  [GYM_ID],
);
const creditsAfter = after.rows[0]!.sms_credits;
const diff = creditsBefore - creditsAfter;

console.log('\n─── PROOF SUMMARY ───────────────────────────────────────────────\n');
console.log(`sms_credits BEFORE : ${creditsBefore}`);
console.log(`sms_credits AFTER  : ${creditsAfter}`);
console.log(`Credits decremented: ${diff === 1 ? `✅ YES (-1)` : `❌ WRONG (diff=${diff})`}`);
console.log(`message_log rows   : ${logRows.rowCount}`);

// ── 6. Cleanup ─────────────────────────────────────────────────────────────
await client.query('BEGIN');
await client.query(`SET LOCAL app.current_gym_id = '${GYM_ID}'`);
await client.query(`SET LOCAL ROLE app_backend`);
await client.query(`DELETE FROM members WHERE id = $1`, [member.id]);
await client.query('COMMIT');
console.log(`\nTest member ${member.id} deleted — cleanup done.`);

await client.end();
