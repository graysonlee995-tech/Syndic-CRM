// Vercel serverless entry: every /api/* request is handled by the Express app.
// The web UI is served as static files from web/dist (see vercel.json).
import { createApp } from '../server/dist/app.js';
import { createFirstAdmin } from '../server/dist/scripts/first-admin.js';

const app = createApp();
let setup = null;

export default async function handler(req, res) {
  setup ??= createFirstAdmin().catch((err) => {
    setup = null;
    console.error('[setup] first admin check failed:', err);
  });
  await setup;
  return app(req, res);
}
