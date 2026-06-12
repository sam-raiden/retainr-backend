/**
 * Postgres connection layer.
 *
 * The whole tenancy model lives or dies on `withTenant()` below. Read the
 * docstring there before adding any new query callsite.
 *
 * Connection vs. effective role — these are different things:
 *
 *   - `pool` authenticates through Supabase's transaction pooler as
 *     `postgres.<project-ref>` (Supavisor doesn't resolve custom-role
 *     usernames like `app_backend`).
 *   - Every query path (`withTenant` and `unscoped`) immediately runs
 *     `SET LOCAL ROLE app_backend` inside its transaction. `app_backend`
 *     has NOBYPASSRLS, so RLS is enforced for the rest of that transaction
 *     regardless of what `postgres` itself could do. `SET LOCAL` resets at
 *     COMMIT/ROLLBACK — safe under transaction-mode pooling, no leakage to
 *     the next pooled client.
 *   - `verifyTenancySetup()` runs once at boot and fails hard if
 *     `app_backend` is missing, the GRANT is missing, or `app_backend`
 *     somehow has BYPASSRLS.
 *
 *   adminPool  — optional. Connects with BYPASSRLS (postgres / service_role),
 *                stays as `postgres` (no SET LOCAL ROLE). Reserved for
 *                migrations and one-off support work, never request
 *                handlers. Built only if DATABASE_ADMIN_URL is set.
 */
import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import { env } from '../config/env.js';

const { Pool, types } = pg;

// --------------------------------------------------------------------------
// Type parsing
// --------------------------------------------------------------------------

// DATE (oid 1082) — return the raw 'YYYY-MM-DD' wire string instead of pg's
// default Date object. Every membership date in this app is a calendar date
// with no time component; parsing it into a Date and back risks off-by-one
// errors across timezones. Services pass these strings straight to
// src/services/dates.ts.
types.setTypeParser(1082, (val) => val);

// NUMERIC (oid 1700) — return a JS number instead of a string. Prices and
// payment amounts here are small INR values where float precision is a
// non-issue, and callers (JSON responses, arithmetic in dates/dashboard
// services) all want numbers.
types.setTypeParser(1700, (val) => parseFloat(val));

// --------------------------------------------------------------------------
// Pool construction
// --------------------------------------------------------------------------

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Conservative limits for a small VPS / Railway / Render free tier.
  // Tune up only once we see real load.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Defence against runaway tenant queries. 10s is plenty for any
  // single CRUD or dashboard read; long imports run in workers.
  statement_timeout: 10_000,
  // Reasonable client-side query timeout fallback.
  query_timeout: 12_000,
});

pool.on('error', (err) => {
  // Pool errors arrive on idle clients (e.g., the network blipped between
  // queries). Log and let pg reconnect — don't crash the process.
  // eslint-disable-next-line no-console
  console.error('[pg pool] background error:', err.message);
});

export const adminPool = env.DATABASE_ADMIN_URL
  ? new Pool({
      connectionString: env.DATABASE_ADMIN_URL,
      max: 2,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    })
  : null;

// The role every request-handling transaction switches into. NOBYPASSRLS —
// granted to `postgres` via `GRANT app_backend TO postgres` (one-time setup).
const APP_ROLE = 'app_backend';

// --------------------------------------------------------------------------
// withTenant — the only legal way to query tenant data
// --------------------------------------------------------------------------

/**
 * Run a function with a tenant-scoped DB client.
 *
 * Opens a transaction, runs `SELECT set_current_gym_id($1)` so RLS policies
 * filter by this tenant, hands the client to the callback, then commits on
 * success / rolls back on error. The client is always released.
 *
 * The session variable is set with set_config(..., true) which scopes it
 * to the current transaction, so once we COMMIT or ROLLBACK the value
 * disappears — no leakage to the next pool client.
 *
 * If you call `pool.query(...)` directly to read tenant data, RLS sees
 * no `app.current_gym_id` and returns ZERO rows. That's the safe-default
 * failure mode — annoying for the developer, no data leak for the gym.
 *
 * Usage:
 *   const members = await withTenant(gymId, async (client) => {
 *     const r = await client.query('SELECT * FROM members ORDER BY name');
 *     return r.rows;
 *   });
 */
export async function withTenant<T>(
  gymId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query('SELECT set_current_gym_id($1)', [gymId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* swallow — we're already throwing the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// unscoped — for SECURITY DEFINER calls and health checks
// --------------------------------------------------------------------------

/**
 * Run a query without tenant scoping. Use ONLY for:
 *
 *   - SELECT auth_lookup_staff($1)
 *   - SELECT create_gym_with_owner($1, ...)
 *   - SELECT 1 (health check)
 *
 * Both functions above are SECURITY DEFINER and were explicitly granted
 * to app_backend; everything else in the public schema still respects RLS.
 *
 * Still runs as `app_backend` (via SET LOCAL ROLE, same as withTenant) —
 * just without `set_current_gym_id`. Any accidental query against a
 * tenant table here returns zero rows rather than every gym's data.
 */
export async function unscoped<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<QueryResult<R>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    const result = await client.query<R>(text, params as unknown[] | undefined);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* swallow — we're already throwing the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// Boot-time safety check
// --------------------------------------------------------------------------

/**
 * Runs once at startup (see src/index.ts). Confirms the connection can
 * actually switch into `app_backend` and that the role is NOBYPASSRLS.
 *
 * This is the runtime replacement for the old "DATABASE_URL must contain
 * app_backend" string check — it tests the thing that actually matters
 * (can we get RLS-enforced access?) instead of the connection string shape.
 *
 * Throws with a descriptive message on any failure; src/index.ts treats
 * that as fatal and exits before binding the HTTP port.
 */
export async function verifyTenancySetup(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    const r = await client.query<{
      role_name: string;
      bypassrls: boolean | null;
    }>(
      `SELECT current_user AS role_name,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
    );
    await client.query('ROLLBACK');

    const row = r.rows[0];
    if (!row || row.role_name !== APP_ROLE) {
      throw new Error(
        `SET LOCAL ROLE ${APP_ROLE} did not take effect (current_user=${row?.role_name ?? 'unknown'}). ` +
          `Run: GRANT ${APP_ROLE} TO postgres;`,
      );
    }
    if (row.bypassrls !== false) {
      throw new Error(
        `Role '${APP_ROLE}' has BYPASSRLS=${String(row.bypassrls)} — tenant isolation ` +
          `would be bypassed. It must be created with NOBYPASSRLS.`,
      );
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* swallow — we're already throwing */
    }
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

export async function closePools(): Promise<void> {
  await pool.end();
  if (adminPool) await adminPool.end();
}
