import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * preHandler for any route that requires a logged-in staff member.
 *
 * On success, `request.user` is populated with the JWT payload
 * (`{ gym_id, staff_id, role }`) — see src/types/fastify-jwt.d.ts.
 * Route handlers use `request.user.gym_id` as the sole input to
 * `withTenant()`.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized', message: 'Missing or invalid token' });
  }
}
