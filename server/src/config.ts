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

/** Running as a Vercel serverless function (Vercel sets VERCEL=1). */
const onVercel = Boolean(process.env.VERCEL);
const isProd = process.env.NODE_ENV === 'production' || onVercel;

// Vercel's default production address, used when APP_URL is not set.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null;

// Cloud hosts (Vercel, Render) have no lasting disk, so in
// production the database and files must live in Supabase. A server with its
// own persistent disk (the Docker VPS setup) can opt out with LOCAL_STORAGE=true.
if (isProd && process.env.LOCAL_STORAGE !== 'true') {
  // Files go to Supabase Storage when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
  // otherwise (still encrypted) into the database, so DATABASE_URL is the only requirement.
  const missing = ['DATABASE_URL'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(', ')}. In production the CRM stores data in Supabase (see .env.example), ` +
        'or set LOCAL_STORAGE=true on a server with a persistent disk.',
    );
  }
}

export const config = {
  isProd,
  onVercel,
  port: Number(env('SERVER_PORT', '3000')),
  appUrl: env('APP_URL', vercelUrl ?? 'http://localhost:5173').replace(/\/$/, ''),
  /** Vercel rejects requests over 4.5 MB, so uploads are capped lower there. */
  maxUploadMb: Number(env('MAX_UPLOAD_MB', onVercel ? '4' : '15')),
  /** The AI assistant; its API key is saved in Settings or set as ANTHROPIC_API_KEY (see assistant/key.ts). */
  assistant: {
    model: env('ASSISTANT_MODEL', 'claude-sonnet-5-5'),
  },
  /** Vercel Cron sends this as a bearer token to /api/cron/daily. */
  cronSecret: process.env.CRON_SECRET ?? '',
  dataDir: path.resolve(rootDir, env('DATA_DIR', './data')),
  timezone: env('APP_TIMEZONE', 'Asia/Karachi'),
  fileKey: loadFileKey(),
  /** Supabase Postgres connection string. Empty: embedded Postgres in DATA_DIR/pgdata. */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** Supabase Storage for encrypted uploads. Empty: files are kept in DATA_DIR/files. */
  supabase: {
    url: (process.env.SUPABASE_URL ?? '').replace(/\/$/, ''),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    bucket: env('SUPABASE_BUCKET', 'crm-files'),
  },
  sessionIdleHours: Number(env('SESSION_IDLE_HOURS', '8')),
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(env('SMTP_PORT', '587')),
    secure: env('SMTP_SECURE', 'false') === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: env('MAIL_FROM', 'Syndic CRM <no-reply@localhost>'),
  },
  webDist: path.join(rootDir, 'web', 'dist'),
};
