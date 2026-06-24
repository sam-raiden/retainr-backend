/**
 * TEMPORARY test endpoints — remove once confirmed working in production.
 * All routes protected by requireAuth.
 *
 *   POST /api/v1/test/owner-summary        — text summary for all gyms
 *   POST /api/v1/test/owner-summary-image  — image summary, returns image URLs
 */
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { runOwnerSummaries } from '../services/runOwnerSummaries.js';
import { sendGymOwnerSummary } from '../services/ownerSummary.js';
import { unscoped } from '../db/pool.js';

interface GymRow {
  gym_id: string;
  gym_name: string;
  owner_phone: string;
  sms_credits: number;
  sms_frozen: boolean;
}

export default async function testRoutes(app: FastifyInstance) {
  app.post('/api/v1/test/owner-summary', { preHandler: requireAuth }, async (_req, reply) => {
    app.log.info('test: owner-summary triggered manually');
    void runOwnerSummaries(app.log);
    return reply.code(202).send({
      status: 'accepted',
      message: 'Owner summary run started. Check server logs and message_log table.',
    });
  });

  // Image summary test — runs synchronously so we can return the image URLs
  app.post('/api/v1/test/owner-summary-image', { preHandler: requireAuth }, async (_req, reply) => {
    app.log.info('test: owner-summary-image triggered manually');

    const r = await unscoped<GymRow>('SELECT * FROM list_gyms_for_owner_summary()');
    const results: Array<{ gym: string; imageUrl: string | null; status: string }> = [];

    for (const gym of r.rows) {
      if (gym.sms_frozen || gym.sms_credits <= 0) {
        results.push({ gym: gym.gym_name, imageUrl: null, status: 'skipped (frozen/no credits)' });
        continue;
      }
      const imageUrl = await sendGymOwnerSummary(gym.gym_id, gym.gym_name, gym.owner_phone, app.log);
      results.push({ gym: gym.gym_name, imageUrl, status: imageUrl ? 'image sent' : 'text fallback sent' });
      await new Promise(r2 => setTimeout(r2, 500));
    }

    return reply.send({ results });
  });
}
