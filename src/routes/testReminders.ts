import type { FastifyInstance } from 'fastify';

import { runDailyReminders } from '../cron/dailyReminders.js';

/**
 * TEMPORARY — manual trigger for the daily reminder sweep, so it can be
 * tested without waiting for the 08:00 IST cron. Remove this route (and
 * this file) once AiSensy testing is done.
 */
export default async function testReminderRoutes(app: FastifyInstance) {
  app.post('/api/v1/test/run-reminders', async () => {
    const result = await runDailyReminders();
    return result;
  });
}
