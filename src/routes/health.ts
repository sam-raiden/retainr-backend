import type { FastifyInstance } from 'fastify';

import { unscoped } from '../db/pool.js';

/**
 * Public, unauthenticated health endpoints.
 *
 *   GET /              — banner so a human-visited root URL says hello
 *   GET /api/v1/health — load-balancer probe; pings Postgres so a green
 *                        200 means the whole stack is reachable
 */
export default async function healthRoutes(app: FastifyInstance) {
  app.get('/', async () => ({
    name: 'kgf-backend',
    version: '0.1.0',
    status: 'ok',
  }));

  app.get('/api/v1/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      const r = await unscoped<{ now: string }>('SELECT NOW()::text AS now');
      const now = r.rows[0]?.now;
      checks.db = now ? 'ok' : 'unexpected-result';
      if (!now) healthy = false;
    } catch (err) {
      checks.db = `error: ${err instanceof Error ? err.message : 'unknown'}`;
      healthy = false;
    }

    if (!healthy) reply.code(503);

    return {
      status: healthy ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      checks,
    };
  });
}
