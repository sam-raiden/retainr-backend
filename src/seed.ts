/**
 * Seeds a realistic demo gym for manual testing / demos.
 *
 * Idempotent: checks for a staff row with DEMO_EMAIL first and exits early
 * if it already exists, so `npm run seed` is safe to run repeatedly.
 *
 * Run with: npm run seed
 */
import { closePools, withTenant } from './db/pool.js';
import { createGym, hashPassword, lookupStaffByEmail } from './services/auth.js';
import { addCalendarMonths, PLAN_DURATION_MONTHS } from './services/dates.js';

const DEMO_EMAIL = 'demo@kaigreen.fit';
const DEMO_PASSWORD = 'demo1234';

interface SeedMember {
  name: string;
  phone: string;
  plan: 'Standard' | 'Weight Loss';
  payment_date: string;
  payment_status: 'PAID' | 'UNPAID';
  bucket: 'active' | 'expiring' | 'expired' | 'unpaid';
}

// Dates are anchored relative to "today" so the seeded statuses
// (active/expiring/expired) stay correct no matter when this is run.
const SEED_MEMBERS: SeedMember[] = [
  // 8 active — expiry more than 7 days away
  { name: 'Arjun Nair', phone: '9810000001', plan: 'Standard', payment_date: '2026-06-05', payment_status: 'PAID', bucket: 'active' },
  { name: 'Priya Sharma', phone: '9810000002', plan: 'Weight Loss', payment_date: '2026-06-08', payment_status: 'PAID', bucket: 'active' },
  { name: 'Rohit Verma', phone: '9810000003', plan: 'Standard', payment_date: '2026-05-25', payment_status: 'PAID', bucket: 'active' },
  { name: 'Sneha Iyer', phone: '9810000004', plan: 'Weight Loss', payment_date: '2026-05-30', payment_status: 'PAID', bucket: 'active' },
  { name: 'Karan Mehta', phone: '9810000005', plan: 'Standard', payment_date: '2026-06-01', payment_status: 'PAID', bucket: 'active' },
  { name: 'Ananya Reddy', phone: '9810000006', plan: 'Weight Loss', payment_date: '2026-06-10', payment_status: 'PAID', bucket: 'active' },
  { name: 'Vikram Singh', phone: '9810000007', plan: 'Standard', payment_date: '2026-05-22', payment_status: 'PAID', bucket: 'active' },
  { name: 'Divya Pillai', phone: '9810000008', plan: 'Weight Loss', payment_date: '2026-06-03', payment_status: 'PAID', bucket: 'active' },

  // 4 expiring — expiry within 7 days
  { name: 'Rahul Gupta', phone: '9810000009', plan: 'Standard', payment_date: '2026-05-12', payment_status: 'PAID', bucket: 'expiring' },
  { name: 'Pooja Joshi', phone: '9810000010', plan: 'Weight Loss', payment_date: '2026-05-14', payment_status: 'PAID', bucket: 'expiring' },
  { name: 'Aditya Kumar', phone: '9810000011', plan: 'Standard', payment_date: '2026-05-11', payment_status: 'PAID', bucket: 'expiring' },
  { name: 'Neha Desai', phone: '9810000012', plan: 'Weight Loss', payment_date: '2026-05-18', payment_status: 'PAID', bucket: 'expiring' },

  // 4 expired — expiry already past
  { name: 'Suresh Pillai', phone: '9810000013', plan: 'Standard', payment_date: '2026-04-25', payment_status: 'UNPAID', bucket: 'expired' },
  { name: 'Kavya Menon', phone: '9810000014', plan: 'Weight Loss', payment_date: '2026-04-10', payment_status: 'UNPAID', bucket: 'expired' },
  { name: 'Manish Agarwal', phone: '9810000015', plan: 'Standard', payment_date: '2026-05-01', payment_status: 'UNPAID', bucket: 'expired' },
  { name: 'Ritu Bansal', phone: '9810000016', plan: 'Weight Loss', payment_date: '2026-04-15', payment_status: 'UNPAID', bucket: 'expired' },

  // 2 unpaid, no photo — long-overdue, never re-uploaded a photo
  { name: 'Amitabh Rao', phone: '9810000017', plan: 'Standard', payment_date: '2026-03-01', payment_status: 'UNPAID', bucket: 'unpaid' },
  { name: 'Sanjana Kapoor', phone: '9810000018', plan: 'Weight Loss', payment_date: '2026-03-15', payment_status: 'UNPAID', bucket: 'unpaid' },
];

async function main(): Promise<void> {
  const existing = await lookupStaffByEmail(DEMO_EMAIL);
  if (existing) {
    console.log('already seeded');
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const { gymId } = await createGym({
    gymName: 'Kai Green Fitness Demo',
    ownerName: 'Demo Owner',
    ownerPhone: '9999999999',
    email: DEMO_EMAIL,
    passwordHash,
  });

  await withTenant(gymId, async (client) => {
    const values: string[] = [];
    const params: unknown[] = [];
    SEED_MEMBERS.forEach((m, i) => {
      const expiryDate = addCalendarMonths(m.payment_date, PLAN_DURATION_MONTHS);
      const base = i * 7;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
      params.push(gymId, m.name, m.phone, m.plan, m.payment_date, expiryDate, m.payment_status);
    });

    await client.query(
      `INSERT INTO members (gym_id, name, phone, plan, payment_date, expiry_date, payment_status)
       VALUES ${values.join(', ')}`,
      params,
    );
  });

  const counts = SEED_MEMBERS.reduce(
    (acc, m) => {
      acc[m.bucket] += 1;
      return acc;
    },
    { active: 0, expiring: 0, expired: 0, unpaid: 0 },
  );

  console.log(`Gym ID: ${gymId}`);
  console.log(`Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`Members seeded: ${SEED_MEMBERS.length}`);
  console.log(`Active: ${counts.active}, Expiring: ${counts.expiring}, Expired: ${counts.expired}, Unpaid: ${counts.unpaid}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
