import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { purgeIdleSessions } from '../db/repo.js';
import { runBirthdayReminders } from '../jobs/birthdays.js';
import { runExpiryAlerts } from '../jobs/expiryAlerts.js';
import { HttpError } from '../lib/http.js';

/**
 * Daily jobs for hosts without an always-running server (Vercel). Vercel Cron
 * calls GET /api/cron/daily with "Authorization: Bearer $CRON_SECRET"; see
 * vercel.json. Alerts are de-duplicated, so an extra call never re-sends one.
 */
export const cronRouter = Router();

function authorized(header: string | undefined): boolean {
  if (!config.cronSecret || !header) return false;
  const expected = Buffer.from(`Bearer ${config.cronSecret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

cronRouter.get('/daily', async (req, res) => {
  if (!authorized(req.get('authorization'))) throw new HttpError(401, 'Unauthorized');
  const expiry = await runExpiryAlerts();
  const birthdays = await runBirthdayReminders();
  await purgeIdleSessions(config.sessionIdleHours);
  console.log(`[cron] ${expiry.message}. ${birthdays.message}.`);
  res.json({ expiry: expiry.message, birthdays: birthdays.message });
});
