/**
 * TEMPORARY test endpoints — remove before leaving in production long-term.
 * Protected by requireAuth so they cannot be called without a valid JWT.
 *
 *   POST /api/v1/test/owner-summary  — triggers runOwnerSummaries() immediately
 */
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { runOwnerSummaries } from '../services/runOwnerSummaries.js';

export default async function testRoutes(app: FastifyInstance) {
  app.post('/api/v1/test/owner-summary', { preHandler: requireAuth }, async (_req, reply) => {
    app.log.info('test: owner-summary triggered manually');
    // Run async — respond immediately so the HTTP client doesn't time out
    // while waiting for all AiSensy calls to complete.
    void runOwnerSummaries(app.log);
    return reply.code(202).send({
      status: 'accepted',
      message: 'Owner summary run started. Check server logs and message_log table.',
    });
  });
}
