import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { runDailyJobs } from '../jobs/scheduler.js';

/**
 * Daily job trigger. Vercel Cron (vercel.json) calls GET /api/cron/daily and sends
 * "Authorization: Bearer <CRON_SECRET>" automatically when CRON_SECRET is set.
 */
export const cronRouter = Router();

function secretMatches(header: string | undefined): boolean {
  if (!config.cronSecret || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.cronSecret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

cronRouter.all('/daily', async (req, res) => {
  if (!secretMatches(req.get('authorization'))) {
    res.status(401).json({ error: 'Invalid cron secret' });
    return;
  }
  const result = await runDailyJobs('scheduled run');
  res.json(result);
});
