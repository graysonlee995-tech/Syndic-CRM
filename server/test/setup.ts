import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

// Each test file runs in its own worker with a fresh Postgres database, file folder and key.
// Point TEST_DATABASE_URL at a local Postgres server whose user can create databases.
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SMTP_HOST = '';
process.env.SUPABASE_URL = '';
process.env.IN_APP_SCHEDULER = 'false';

const base = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const dbName = `crm_test_${crypto.randomBytes(6).toString('hex')}`;
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
const url = new URL(base);
url.pathname = `/${dbName}`;
process.env.DATABASE_URL = url.toString();
