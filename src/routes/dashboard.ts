import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { getDashboard } from '../services/members.js';

/**
 * GET /api/v1/dashboard — counts by status, this month's revenue, and the
 * list of members expiring within 7 days (for the "Expiring this week"
 * card on the home screen).
 */
export default async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/v1/dashboard', { preHandler: requireAuth }, async (req) => {
    return getDashboard(req.user.gym_id);
  });
}
