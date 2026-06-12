import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { IdParamSchema } from '../schemas/common.js';
import { PlanCreateSchema } from '../schemas/plan.js';
import { ConflictError } from '../utils/errors.js';
import { createPlan, deactivatePlan, listActivePlans } from '../services/plans.js';

/**
 * Membership plans.
 *
 *   GET    /api/v1/plans     — this gym's active plans (Standard / Weight Loss
 *                               by default, seeded on gym creation)
 *   POST   /api/v1/plans     — create a custom plan (name, price, duration in months)
 *   DELETE /api/v1/plans/:id — deactivate a plan. Members already on it keep
 *                               their plan name (snapshot on members.plan) —
 *                               only new enrollments/renewals stop seeing it.
 */
export default async function planRoutes(app: FastifyInstance) {
  app.get('/api/v1/plans', { preHandler: requireAuth }, async (req) => {
    const plans = await listActivePlans(req.user.gym_id);
    return { plans };
  });

  app.post('/api/v1/plans', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = PlanCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }

    try {
      const plan = await createPlan(req.user.gym_id, parsed.data);
      reply.code(201);
      return { plan };
    } catch (err) {
      if (err instanceof ConflictError) {
        return reply.code(409).send({ error: 'Conflict', message: err.message });
      }
      throw err;
    }
  });

  app.delete('/api/v1/plans/:id', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid plan id' });
    }

    await deactivatePlan(req.user.gym_id, params.data.id);
    return reply.code(204).send();
  });
}
