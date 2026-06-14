/**
 * Environment loader. Runs once at startup, validates with Zod, exits
 * with a readable error if anything required is missing or wrong.
 *
 * DATABASE_URL connects as `postgres.<project-ref>` through Supabase's
 * transaction pooler — Supavisor only resolves `postgres.<project-ref>` as
 * a username, custom roles like `app_backend` return
 * "(ENOTFOUND) tenant/user ... not found" at the pooler layer.
 *
 * Tenant isolation is NOT done by connecting as a restricted role. Instead,
 * every query path (`withTenant` / `unscoped` in src/db/pool.ts) opens a
 * transaction and runs `SET LOCAL ROLE app_backend` (NOBYPASSRLS) before
 * touching any table. `SET LOCAL` resets at COMMIT/ROLLBACK, so it's safe
 * under transaction-mode pooling — verified at boot by
 * `verifyTenancySetup()`, which fails hard if `app_backend` ever turns out
 * to have BYPASSRLS.
 *
 * One-time prerequisite (already applied to this project):
 *   GRANT app_backend TO postgres;
 * — without it, `SET LOCAL ROLE app_backend` raises "permission denied to
 * set role".
 */
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  DATABASE_URL: z
    .string()
    .url('DATABASE_URL must be a valid postgres:// URL')
    .refine((url) => url.includes(':6543'), {
      message:
        'DATABASE_URL should target Supabase\'s transaction pooler on port 6543. ' +
        'SET LOCAL ROLE / SET LOCAL app.current_gym_id need transaction-mode ' +
        'pooling to behave correctly (resets per-transaction, no leakage).',
    }),
  DATABASE_ADMIN_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short'),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('member-photos'),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  CORS_ORIGINS: z.string().default(''),

  REDIS_URL: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  AISENSY_API_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  AISENSY_API_KEY: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  AISENSY_CAMPAIGN_NAME: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Write directly to stderr — logger isn't up yet.
  process.stderr.write('\n❌  Invalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    process.stderr.write(`    • ${issue.path.join('.') || '(root)'}: ${issue.message}\n`);
  }
  process.stderr.write(
    '\nCheck backend/.env against backend/.env.example, then restart.\n\n',
  );
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const isDev = env.NODE_ENV === 'development';
export const isProd = env.NODE_ENV === 'production';
