import { config } from './config.js';
import { createApp } from './app.js';
import { startScheduler } from './jobs/scheduler.js';
import { mailConfigured } from './lib/mailer.js';
import { createFirstAdmin } from './scripts/first-admin.js';

await createFirstAdmin();
const app = createApp();

app.listen(config.port, () => {
  console.log(`Travel CRM server listening on http://localhost:${config.port}`);
  console.log(`File storage: ${config.supabaseUrl ? `Supabase bucket "${config.storageBucket}"` : config.dataDir}`);
  if (!mailConfigured) console.warn('SMTP is not configured: expiry alert emails will be logged, not sent.');
  startScheduler().catch((err) => console.error('[scheduler] failed to start:', err));
});
