import 'dotenv/config';
import { readFileSync } from 'fs';
import pg from 'pg';

// Use direct admin connection (not pooler) for DDL statements
const url = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
const client = new pg.Client({ connectionString: url });

const migrations = [
  'migration_004_message_log.sql',
  'migration_005_sms_credits.sql',
  'migration_006_list_gyms_for_reminders_v2.sql',
];

await client.connect();
console.log('Connected to database.\n');

for (const file of migrations) {
  const sql = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  console.log(`Running ${file}...`);
  try {
    await client.query(sql);
    console.log(`  ✓ Done\n`);
  } catch (err) {
    console.error(`  ✗ FAILED: ${err.message}\n`);
    await client.end();
    process.exit(1);
  }
}

// ── Verification queries ────────────────────────────────────────────────────
console.log('=== VERIFICATION ===\n');

// 1. sms_credits + sms_frozen columns on gyms
const cols = await client.query(`
  SELECT column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_name = 'gyms'
    AND column_name IN ('sms_credits', 'sms_frozen')
  ORDER BY column_name
`);
console.log('gyms columns (sms_credits, sms_frozen):');
console.table(cols.rows);

// 2. message_log table exists
const tbl = await client.query(`
  SELECT table_name, table_type
  FROM information_schema.tables
  WHERE table_name = 'message_log'
`);
console.log('message_log table:');
console.table(tbl.rows);

// 3. list_gyms_for_reminders() returns all 4 columns
const fn = await client.query(`SELECT * FROM list_gyms_for_reminders() LIMIT 5`);
console.log('list_gyms_for_reminders() — columns returned:', fn.fields.map(f => f.name));
console.log('Row count:', fn.rowCount);
if (fn.rows.length > 0) console.table(fn.rows);

await client.end();
console.log('\nAll done.');
