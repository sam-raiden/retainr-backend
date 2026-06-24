/**
 * Quick local test: generate the summary image and upload to Supabase.
 * Prints the public URL so you can preview it in a browser.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { generateDailySummaryImage } from './src/services/imageGenerator.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const expiring = [
  { name: 'Arjun Sharma',    plan: 'Standard',    price: 800,  phone: '9876501234' },
  { name: 'Priya Nair',      plan: 'Weight Loss',  price: 1500, phone: '9123456780' },
  { name: 'Ramesh Kumar',    plan: 'Standard',     price: 800,  phone: '9988776655' },
  { name: 'Divya Menon',     plan: 'summer',       price: 2000, phone: '8877665544' },
  { name: 'Karthik Raj',     plan: 'Weight Loss',  price: 1500, phone: '9001122334' },
];

const expired = [
  { name: 'Suresh Babu',     plan: 'Standard',    price: 800,  phone: '8001122334' },
  { name: 'Kavitha Raj',     plan: 'Weight Loss', price: 1500, phone: '8112233445' },
  { name: 'Dinesh Kumar',    plan: 'Standard',    price: 800,  phone: '8223344556' },
];

console.log('Generating image...');
const buf = await generateDailySummaryImage(
  'Kai Green Fitness',
  'Monday, 23 June 2026',
  expiring,
  expired,
);
console.log(`PNG buffer size: ${(buf.length / 1024).toFixed(1)} KB`);

const path = 'preview/test-image.png';
const { error } = await supabase.storage
  .from('daily-summaries')
  .upload(path, buf, { contentType: 'image/png', upsert: true });

if (error) { console.error('Upload failed:', error.message); process.exit(1); }

const { data } = supabase.storage.from('daily-summaries').getPublicUrl(path);
console.log('\n✅ IMAGE URL (open in browser to verify):');
console.log(data.publicUrl);
