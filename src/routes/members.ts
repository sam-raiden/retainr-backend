import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { IdParamSchema } from '../schemas/common.js';
import { MemberCreateSchema, MemberRenewSchema, MemberUpdateSchema } from '../schemas/member.js';
import { BULK_IMPORT_TEMPLATE_CSV, bulkImportMembers, parseMembersCsv } from '../services/bulkImport.js';
import { assertValidPhoto, uploadMemberPhoto } from '../services/photos.js';
import { createMember, deleteMember, listMembers, renewMember, setMemberPhoto, updateMember } from '../services/members.js';
import { listMemberPayments } from '../services/payments.js';
import { listActivePlans } from '../services/plans.js';
import { HttpError } from '../utils/errors.js';

/** Returns an error message if `plan` isn't one of this gym's active plan names, else null. */
async function checkActivePlan(gymId: string, plan: string): Promise<string | null> {
  const activePlans = await listActivePlans(gymId);
  if (activePlans.some((p) => p.name === plan)) return null;
  return `Plan must be one of this gym's active plans: ${activePlans.map((p) => p.name).join(', ') || '(none active)'}`;
}

/**
 * Member CRUD + renewal.
 *
 *   GET    /api/v1/members                      — list every member in this gym
 *   POST   /api/v1/members                      — add a member
 *   PATCH  /api/v1/members/:id                  — edit a member
 *   DELETE /api/v1/members/:id                  — remove a member
 *   POST   /api/v1/members/:id/renew            — start a new cycle today, log a payment
 *   POST   /api/v1/members/:id/photo            — upload/replace the member's profile photo
 *   GET    /api/v1/members/bulk-import/template — download the CSV template
 *   POST   /api/v1/members/bulk-import          — bulk-create members from a CSV
 */
export default async function memberRoutes(app: FastifyInstance) {
  app.get('/api/v1/members', { preHandler: requireAuth }, async (req) => {
    const members = await listMembers(req.user.gym_id);
    return { members };
  });

  app.post('/api/v1/members', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = MemberCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }

    const planError = await checkActivePlan(req.user.gym_id, parsed.data.plan);
    if (planError) {
      return reply.code(400).send({ error: 'Bad Request', message: planError });
    }

    try {
      const result = await createMember(req.user.gym_id, parsed.data);
      reply.code(201);
      return result;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === '23505') {
        return reply.code(409).send({ error: 'Conflict', message: 'A member with this phone number already exists' });
      }
      throw err;
    }
  });

  app.patch('/api/v1/members/:id', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid member id' });
    }

    const parsed = MemberUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }

    if (parsed.data.plan !== undefined) {
      const planError = await checkActivePlan(req.user.gym_id, parsed.data.plan);
      if (planError) {
        return reply.code(400).send({ error: 'Bad Request', message: planError });
      }
    }

    try {
      const member = await updateMember(req.user.gym_id, params.data.id, parsed.data);
      return { member };
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === '23505') {
        return reply.code(409).send({ error: 'Conflict', message: 'A member with this phone number already exists' });
      }
      throw err;
    }
  });

  app.delete('/api/v1/members/:id', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid member id' });
    }

    await deleteMember(req.user.gym_id, params.data.id);
    return reply.code(204).send();
  });

  app.post('/api/v1/members/:id/renew', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid member id' });
    }

    const parsed = MemberRenewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }

    if (parsed.data.plan !== undefined) {
      const planError = await checkActivePlan(req.user.gym_id, parsed.data.plan);
      if (planError) {
        return reply.code(400).send({ error: 'Bad Request', message: planError });
      }
    }

    return renewMember(req.user.gym_id, params.data.id, parsed.data);
  });

  app.get('/api/v1/members/:id/payments', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid member id' });
    }
    const payments = await listMemberPayments(req.user.gym_id, params.data.id);
    return { payments };
  });

  app.post('/api/v1/members/:id/photo', { preHandler: requireAuth }, async (req, reply) => {
    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid member id' });
    }

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'Bad Request', message: 'No photo provided' });
    }

    const buffer = await file.toBuffer();
    if (file.file.truncated) {
      throw new HttpError(413, 'Photo must be 5MB or smaller');
    }
    assertValidPhoto(file.mimetype, buffer.length);

    const photoUrl = await uploadMemberPhoto(req.user.gym_id, params.data.id, buffer, file.mimetype);
    const member = await setMemberPhoto(req.user.gym_id, params.data.id, photoUrl);
    return { member };
  });

  app.get('/api/v1/members/bulk-import/template', { preHandler: requireAuth }, async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="member-import-template.csv"');
    return BULK_IMPORT_TEMPLATE_CSV;
  });

  app.post('/api/v1/members/bulk-import', { preHandler: requireAuth }, async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'Bad Request', message: 'No CSV file provided' });
    }
    if (!file.filename?.toLowerCase().endsWith('.csv')) {
      return reply.code(415).send({ error: 'Unsupported Media Type', message: 'File must be a .csv file' });
    }

    const buffer = await file.toBuffer();
    if (file.file.truncated) {
      throw new HttpError(413, 'CSV file is too large');
    }

    const records = parseMembersCsv(buffer);
    return bulkImportMembers(req.user.gym_id, records);
  });
}
