import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { IdParamSchema } from '../schemas/common.js';
import { deletePayment, listPayments } from '../services/payments.js';

/**
 * Payment history (Finance page).
 *
 *   GET    /api/v1/payments     — every payment for this gym, newest first
 *   DELETE /api/v1/payments/:id — undo a renewal's payment record
 */
export default async function paymentRoutes(app: FastifyInstance) {
  app.get('/api/v1/payments', { preHandler: requireAuth }, async (req) => {
    const payments = await listPayments(req.user.gym_id);
    return { payments };
  });

  app.delete('/api/v1/payments/:id', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid payment id' });
    }

    await deletePayment(req.user.gym_id, params.data.id);
    return reply.code(204).send();
  });
}
