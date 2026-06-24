import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data, error } = await supabase.storage.createBucket('daily-summaries', {
  public: true,  // AiSensy needs to fetch the URL directly
  fileSizeLimit: 5 * 1024 * 1024,
  allowedMimeTypes: ['image/png', 'image/jpeg'],
});

if (error && !error.message.includes('already exists')) {
  console.error('Failed:', error.message);
  process.exit(1);
}

const { data: buckets } = await supabase.storage.listBuckets();
const bucket = buckets?.find(b => b.name === 'daily-summaries');
console.log('Bucket:', bucket?.name, '| public:', bucket?.public);
