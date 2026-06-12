import '@fastify/jwt';

/**
 * Shape of our JWT payload / `request.user` after `request.jwtVerify()`.
 * Every protected route reads `request.user.gym_id` to scope its
 * `withTenant()` call — this is the single source of tenant identity
 * for the whole request lifecycle.
 */
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      gym_id: string;
      staff_id: string;
      role: string;
    };
    user: {
      gym_id: string;
      staff_id: string;
      role: string;
    };
  }
}
