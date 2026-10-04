import path from 'node:path';
import dotenv from 'dotenv';

const rootDir = path.resolve(import.meta.dirname, '../..');

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function loadFileKey(): Buffer {
  const key = Buffer.from(env('FILE_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) {
    throw new Error('FILE_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  }
  return key;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  // Render and most hosts set PORT; SERVER_PORT is kept for Docker.
  port: Number(process.env.PORT || env('SERVER_PORT', '3000')),
  appUrl: env('APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
  dataDir: path.resolve(rootDir, env('DATA_DIR', './data')),
  /** Postgres connection string (Supabase: Project Settings > Database > Session pooler). */
  databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/crm'),
  /** Supabase project URL and service role key. Without them files are stored in DATA_DIR/files. */
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  storageBucket: env('SUPABASE_BUCKET', 'documents'),
  /**
   * Where encrypted scans are kept: "db" (a table in the Supabase database, the default),
   * "supabase" (a private Storage bucket, needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)
   * or "disk" (DATA_DIR/files, for local development and tests).
   */
  fileStorage: env(
    'FILE_STORAGE',
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'db',
  ) as 'db' | 'supabase' | 'disk',
  /** Shared secret for POST /api/cron/daily (called by Supabase pg_cron). Empty disables the endpoint. */
  cronSecret: process.env.CRON_SECRET ?? '',
  /** Set to false on hosts that sleep (Render free); the daily job then comes from Supabase pg_cron. */
  inAppScheduler: env('IN_APP_SCHEDULER', 'true') === 'true',
  timezone: env('APP_TIMEZONE', 'Asia/Karachi'),
  fileKey: loadFileKey(),
  sessionIdleHours: Number(env('SESSION_IDLE_HOURS', '8')),
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(env('SMTP_PORT', '587')),
    secure: env('SMTP_SECURE', 'false') === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: env('MAIL_FROM', 'Travel CRM <no-reply@localhost>'),
  },
  webDist: path.join(rootDir, 'web', 'dist'),
};
