import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';

import { corsOrigins, env, isDev, isProd } from './config/env.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import healthRoutes from './routes/health.js';
import memberRoutes from './routes/members.js';
import paymentRoutes from './routes/payments.js';
import planRoutes from './routes/plans.js';

/**
 * Compose the Fastify instance. Side-effect free — index.ts handles
 * listening, signals, and shutdown.
 *
 * Return type is intentionally inferred — Fastify's deep generics fight
 * with `exactOptionalPropertyTypes: true` when written by hand.
 */
export async function buildServer() {
  // Pretty logs in dev, structured JSON in prod (parsable by log aggregators).
  // Conditional spread keeps `transport` *omitted* (not `undefined`) in
  // prod — exactOptionalPropertyTypes treats the two differently.
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.password_hash',
        ],
        remove: true,
      },
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss',
                colorize: true,
                ignore: 'pid,hostname',
              },
            },
          }
        : {}),
    },
    // Behind Cloudflare / Railway / Vercel — trust the X-Forwarded-* chain
    // so `req.ip` reflects the real client and not the proxy.
    trustProxy: true,
    // 10 MB — leaves headroom for CSV bulk-import and ≤5 MB photos.
    bodyLimit: 10 * 1024 * 1024,
    disableRequestLogging: false,
    // Hide x-powered-by-style fingerprints.
    ignoreTrailingSlash: true,
    // Reuse an inbound X-Request-ID (set by a proxy/load balancer) or mint
    // a fresh UUID — echoed back below so clients can correlate logs.
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-ID', req.id);
    return payload;
  });

  // ---------- Security headers --------------------------------------------
  // XSS / clickjacking / MIME-sniffing protections via standard headers.
  await app.register(fastifyHelmet);

  // ---------- Rate limiting -------------------------------------------------
  // Global ceiling per IP; auth routes get a much tighter limit below to
  // slow down credential-stuffing / brute-force attempts.
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // ---------- CORS -------------------------------------------------------
  // Whitelist of explicit allowed origins from env, plus any
  // localhost / 127.0.0.1 when NODE_ENV=development so the existing React
  // dev server on :3000 (or any port) can hit us without per-machine config.
  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      // Server-to-server and curl have no Origin header — always allowed.
      if (!origin) return cb(null, true);

      if (
        isDev &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        return cb(null, true);
      }

      if (corsOrigins.includes(origin)) return cb(null, true);

      return cb(new Error(`CORS: origin "${origin}" is not allowed`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  });

  // ---------- Auth ---------------------------------------------------------
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  // ---------- Uploads ------------------------------------------------------
  // Member profile photos — single file, ≤5MB (matches photos.MAX_PHOTO_BYTES).
  await app.register(fastifyMultipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  // ---------- Routes -----------------------------------------------------
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(planRoutes);
  await app.register(memberRoutes);
  await app.register(dashboardRoutes);
  await app.register(paymentRoutes);

  // ---------- 404 --------------------------------------------------------
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'Not Found', path: req.url });
  });

  // ---------- Error handler ----------------------------------------------
  // Never crash, never leak stack traces in prod.
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
    } else {
      req.log.warn({ err: err.message }, 'request failed');
    }
    reply.code(status).send({
      error: err.name || 'Error',
      message:
        status >= 500 && isProd ? 'Internal Server Error' : err.message,
    });
  });

  return app;
}
