import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
});
await client.connect();
console.log('Connected.\n');

const migrations = [
  {
    name: 'migration_010_message_log_member_id_nullable',
    sql: `ALTER TABLE message_log ALTER COLUMN member_id DROP NOT NULL;`,
    // OWNER_SUMMARY rows have no per-member context, need null here.
  },
  {
    name: 'migration_011_list_gyms_for_owner_summary',
    sql: `
CREATE OR REPLACE FUNCTION public.list_gyms_for_owner_summary()
RETURNS TABLE(
  gym_id               uuid,
  gym_name             text,
  owner_phone          text,
  sms_credits          integer,
  sms_frozen           boolean,
  owner_summary_enabled boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id, name, owner_phone, sms_credits, sms_frozen, owner_summary_enabled
  FROM gyms
  WHERE owner_summary_enabled = true
    AND owner_phone IS NOT NULL
    AND owner_phone <> ''
  ORDER BY id;
$$;

GRANT EXECUTE ON FUNCTION public.list_gyms_for_owner_summary() TO app_backend;
    `,
  },
];

for (const { name, sql } of migrations) {
  process.stdout.write(`Running ${name}... `);
  await client.query(sql);
  console.log('✓');
}

// Verify
const nullable = await client.query(`
  SELECT is_nullable FROM information_schema.columns
  WHERE table_name = 'message_log' AND column_name = 'member_id'
`);
console.log('\nmessage_log.member_id nullable:', nullable.rows[0]?.is_nullable);

const fn = await client.query(`SELECT * FROM list_gyms_for_owner_summary() LIMIT 5`);
console.log('list_gyms_for_owner_summary() columns:', fn.fields.map(f => f.name));
console.log('Rows:', fn.rowCount);
if (fn.rows.length) console.table(fn.rows.map(r => ({ ...r, owner_phone: r.owner_phone?.slice(0,4) + '****' })));

await client.end();
