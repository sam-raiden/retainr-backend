import 'dotenv/config';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

// ── 1. DB migration ──────────────────────────────────────────────────────────
const db = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
});
await db.connect();
console.log('Connected to database.\n');

const sql = `ALTER TABLE payments ADD COLUMN IF NOT EXISTS approver_photo_url text;`;
console.log('Running migration_007...');
console.log('SQL:', sql);
await db.query(sql);

const verify = await db.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name = 'payments' AND column_name = 'approver_photo_url'
`);
console.log('\nmigration_007 result:');
console.table(verify.rows);
await db.end();

// ── 2. Supabase Storage bucket ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

console.log('Creating payment-approvals bucket...');
const { data: created, error: createErr } = await supabase.storage.createBucket(
  'payment-approvals',
  { public: false },  // private bucket
);
if (createErr && !createErr.message.includes('already exists')) {
  console.error('Bucket creation failed:', createErr.message);
  process.exit(1);
}

const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
if (listErr) { console.error('Could not list buckets:', listErr.message); process.exit(1); }

const bucket = buckets.find(b => b.name === 'payment-approvals');
console.log('\nBucket verification:');
console.table([{
  name: bucket?.name,
  public: bucket?.public,
  created_at: bucket?.created_at,
}]);
