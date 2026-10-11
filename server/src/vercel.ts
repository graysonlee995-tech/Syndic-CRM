import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app.js';
import { connect } from './db/index.js';

/**
 * Entry point for Vercel's serverless functions (see /api/index.js and
 * vercel.json). Each instance connects and applies migrations once, then
 * serves requests with the same Express app as the regular server. There is
 * no scheduler here: Vercel Cron calls /api/cron/daily instead.
 */
const app = createApp();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await connect();
  app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
