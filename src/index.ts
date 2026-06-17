/**
 * Process entrypoint. Boots Fastify, binds to 0.0.0.0 so containers /
 * Railway / LAN phones can reach it, and wires up graceful shutdown so
 * in-flight requests and DB connections close cleanly on SIGINT/SIGTERM.
 */
import { env } from './config/env.js';
import { closePools, verifyTenancySetup } from './db/pool.js';
import { buildServer } from './server.js';
import { startDailyCron } from './cron/dailyReminders.js';

async function main(): Promise<void> {
  const app = await buildServer();

  // Fail fast if `app_backend` isn't reachable / isn't NOBYPASSRLS — better
  // to crash at boot than to silently serve cross-tenant data.
  try {
    await verifyTenancySetup();
    app.log.info('tenancy check ok — app_backend reachable, NOBYPASSRLS confirmed');
  } catch (err) {
    app.log.fatal({ err }, 'tenancy check failed — refusing to start');
    await app.close();
    await closePools();
    process.exit(1);
  }

  await app.listen({ host: '0.0.0.0', port: env.PORT });

  startDailyCron(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutdown requested');
    try {
      await app.close();
      await closePools();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed — exiting hard');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // Last-resort safety net. Don't swallow — log and exit so the process
  // manager (Railway, systemd, docker restart) brings us back.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ reason }, 'unhandledRejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal: server failed to boot', err);
  process.exit(1);
});
