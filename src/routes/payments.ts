import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { IdParamSchema } from '../schemas/common.js';
import { deletePayment, listPayments } from '../services/payments.js';
import { generateSignedUrl, uploadPaymentApprovalPhoto } from '../services/paymentPhotos.js';
import { HttpError } from '../utils/errors.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Payment history (Finance page).
 *
 *   GET    /api/v1/payments                       — every payment for this gym, newest first
 *   DELETE /api/v1/payments/:id                   — undo a renewal's payment record
 *   POST   /api/v1/payments/:id/approver-photo    — attach identity-capture photo to a payment
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

  app.post('/api/v1/payments/:id/approver-photo', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid payment id' });
    }

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'Bad Request', message: 'No photo provided' });
    }

    const buffer = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, 'Photo must be under 5 MB');

    const mime = file.mimetype.split(';')[0]?.trim() ?? '';
    if (!ALLOWED_MIME.has(mime)) {
      return reply.code(415).send({ error: 'Unsupported Media Type', message: 'Photo must be JPEG, PNG, or WEBP' });
    }
    if (buffer.length > MAX_BYTES) throw new HttpError(413, 'Photo must be under 5 MB');

    // uploadPaymentApprovalPhoto stores the durable storage PATH in the DB.
    // We then generate a fresh 1-hour signed URL to return for immediate display.
    const storagePath = await uploadPaymentApprovalPhoto(
      req.user.gym_id,
      params.data.id,
      buffer,
      mime,
    );
    const signedUrl = await generateSignedUrl(storagePath);

    return { approver_photo_url: signedUrl };
  });
}
