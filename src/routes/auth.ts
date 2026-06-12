import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../middleware/auth.js';
import { LoginSchema } from '../schemas/auth.js';
import { GymCreateSchema } from '../schemas/gym.js';
import {
  createGym,
  getGymSummary,
  getStaffSummary,
  hashPassword,
  lookupStaffByEmail,
  verifyPassword,
} from '../services/auth.js';

/**
 * Auth + onboarding.
 *
 *   POST /api/v1/auth/login — email+password -> { token, gym, staff }
 *   POST /api/v1/gyms       — create a new gym + owner -> { token, gym, staff }
 *   GET  /api/v1/me         — re-fetch { gym, staff } for an existing token
 *
 * Login and gym-creation both go through SECURITY DEFINER functions via
 * `unscoped()` because no tenant context exists yet — see
 * src/services/auth.ts and src/db/pool.ts.
 */
export default async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }
    const { email, password } = parsed.data;

    const staff = await lookupStaffByEmail(email);
    const passwordOk = await verifyPassword(password, staff?.password_hash ?? null);
    if (!staff || !passwordOk) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid email or password' });
    }

    const [gym, staffSummary] = await Promise.all([
      getGymSummary(staff.gym_id),
      getStaffSummary(staff.gym_id, staff.staff_id),
    ]);

    const token = await reply.jwtSign({
      gym_id: staff.gym_id,
      staff_id: staff.staff_id,
      role: staff.role,
    });

    return { token, gym, staff: staffSummary };
    },
  );

  app.post('/api/v1/gyms', async (req, reply) => {
    const parsed = GymCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }
    const { gym_name, owner_name, owner_phone, email, password } = parsed.data;

    const passwordHash = await hashPassword(password);

    let created: { gymId: string; staffId: string };
    try {
      created = await createGym({
        gymName: gym_name,
        ownerName: owner_name,
        ownerPhone: owner_phone,
        email,
        passwordHash,
      });
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === '23505') {
        return reply.code(409).send({ error: 'Conflict', message: 'Email already registered' });
      }
      throw err;
    }

    const [gym, staffSummary] = await Promise.all([
      getGymSummary(created.gymId),
      getStaffSummary(created.gymId, created.staffId),
    ]);

    const token = await reply.jwtSign({
      gym_id: created.gymId,
      staff_id: created.staffId,
      role: 'owner',
    });

    reply.code(201);
    return { token, gym, staff: staffSummary };
  });

  app.get('/api/v1/me', { preHandler: requireAuth }, async (req) => {
    const { gym_id, staff_id } = req.user;
    const [gym, staff] = await Promise.all([
      getGymSummary(gym_id),
      getStaffSummary(gym_id, staff_id),
    ]);
    return { gym, staff };
  });
}
