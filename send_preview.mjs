import 'dotenv/config';

const expiringToday = [
  'Arjun Sharma - Rs.800 - 9876501234',
  'Priya Nair - Rs.1500 - 9123456780',
  'Ramesh Kumar - Rs.800 - 9988776655',
  'Divya Menon - Rs.2000 - 8877665544',
  'Karthik Raj - Rs.1500 - 9001122334',
  'Sunita Pillai - Rs.800 - 9112233445',
  'Venkat Reddy - Rs.2000 - 9223344556',
  'Lakshmi Iyer - Rs.1500 - 9334455667',
  'Mohan Das - Rs.800 - 9445566778',
  'Anitha Suresh - Rs.2000 - 9556677889',
].join('\n');

const alreadyExpired = [
  'Suresh Babu - Rs.800 - 8001122334',
  'Kavitha Raj - Rs.1500 - 8112233445',
  'Dinesh Kumar - Rs.800 - 8223344556',
  'Meena Pillai - Rs.2000 - 8334455667',
  'Ravi Shankar - Rs.800 - 8445566778',
  'Nithya Devi - Rs.1500 - 8556677889',
  'Prakash M - Rs.800 - 8667788990',
  'Shalini Nair - Rs.2000 - 8778899001',
  'Murugan K - Rs.800 - 8889900112',
  'Deepa Krishnan - Rs.1500 - 8990011223',
].join('\n');

const payload = {
  apiKey: process.env.AISENSY_API_KEY,
  campaignName: 'gym_owner_summary',
  destination: '918825959572',
  userName: 'Kai Green Fitness',
  templateParams: [
    'Kai Green Fitness',
    'Monday, 23 June 2026',
    '10',
    expiringToday,
    '10',
    alreadyExpired,
  ],
  source: 'retainr-preview',
  media: {}, buttons: [], carouselCards: [],
};

const res = await fetch(process.env.AISENSY_API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const body = await res.text();
console.log('HTTP:', res.status);
console.log('Response:', body);
