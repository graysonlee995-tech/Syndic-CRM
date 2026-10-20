import { config } from './config.js';
import { createApp } from './app.js';
import { connect } from './db/index.js';
import { startScheduler } from './jobs/scheduler.js';
import { usingSupabaseStorage } from './lib/files.js';
import { mailStatus } from './lib/mailer.js';

// Open the database and apply migrations before taking requests.
await connect();

const app = createApp();

app.listen(config.port, () => {
  console.log(`Syndic CRM server listening on http://localhost:${config.port}`);
  console.log(config.databaseUrl ? 'Database: Postgres (DATABASE_URL)' : `Database: embedded Postgres in ${config.dataDir}`);
  console.log(usingSupabaseStorage ? `Files: Supabase Storage bucket "${config.supabase.bucket}"` : config.databaseUrl ? 'Files: database (stored_files)' : `Files: ${config.dataDir}`);
  mailStatus()
    .then((m) => !m.configured && console.warn('Email is not set up (Settings > Email): alert emails will be logged, not sent.'))
    .catch(() => undefined);
  startScheduler().catch((err) => console.error('[scheduler] failed to start:', err));
});
