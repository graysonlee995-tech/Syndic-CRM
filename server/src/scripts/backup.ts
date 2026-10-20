/**
 * Writes every table to DATA_DIR/backups/crm-<time>.json and keeps the last 14
 * (the same format as Settings > Backup, so it can be imported there).
 * Works against Supabase (DATABASE_URL) and the local embedded database.
 * Uploaded files are stored encrypted (Supabase Storage or DATA_DIR/files) and
 * are not included; they are useless without FILE_ENCRYPTION_KEY anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { exportDatabase } from '../db/backup.js';
import { disconnect } from '../db/index.js';

const KEEP = 14;
const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(dir, `crm-${stamp}.json`);
fs.writeFileSync(target, JSON.stringify(await exportDatabase()));
console.log(`Database backed up to ${target}`);

const old = fs
  .readdirSync(dir)
  .filter((f) => /^crm-.*\.json$/.test(f))
  .sort()
  .slice(0, -KEEP);
for (const f of old) fs.rmSync(path.join(dir, f));

await disconnect();
