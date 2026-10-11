import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test file runs in its own worker with a fresh database and key.
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SMTP_HOST = '';
process.env.CRON_SECRET = 'test-cron-secret';
