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
  try {
    await connect();
  } catch (err) {
    // Without this the function crashes and Vercel only shows FUNCTION_INVOCATION_FAILED.
    const e = err as { code?: string; message?: string };
    console.error('[db] could not connect:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The database is not reachable', code: e.code ?? null, reason: String(e.message ?? '').slice(0, 120) }));
    return;
  }
  app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
