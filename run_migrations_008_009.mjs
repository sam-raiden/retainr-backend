import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
});
await client.connect();
console.log('Connected.\n');

const migrations = [
  {
    name: 'migration_008_owner_summary_enabled',
    sql: `ALTER TABLE gyms
            ADD COLUMN IF NOT EXISTS owner_summary_enabled BOOLEAN NOT NULL DEFAULT true;`,
  },
  {
    name: 'migration_009_message_type',
    sql: `ALTER TABLE message_log
            ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'MEMBER_REMINDER';`,
  },
];

for (const { name, sql } of migrations) {
  process.stdout.write(`Running ${name}... `);
  await client.query(sql);
  console.log('✓');
}

// Verify
const result = await client.query(`
  SELECT table_name, column_name, data_type, column_default
  FROM information_schema.columns
  WHERE (table_name = 'gyms'         AND column_name = 'owner_summary_enabled')
     OR (table_name = 'message_log'  AND column_name = 'message_type')
  ORDER BY table_name, column_name
`);
console.log('\nVerification:');
console.table(result.rows);
await client.end();
