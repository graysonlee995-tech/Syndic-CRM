/**
 * One-time copy of the old SQLite database (DATA_DIR/crm.db) and its encrypted
 * files (DATA_DIR/files) into the configured database and file storage, e.g.
 * Supabase. Record ids are kept, so links between records stay intact.
 *
 *   npm run import-sqlite -w server
 *
 * Refuses to run if the target already has employees, so it cannot create duplicates.
 * Uses the same FILE_ENCRYPTION_KEY: files are copied still encrypted.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { column, disconnect, run, tx, value, type Param } from '../db/index.js';
import { reindexClient } from '../db/repo.js';
import { TABLES } from '../db/schema.js';
import { putEncryptedFile } from '../lib/files.js';

const sqlitePath = path.join(config.dataDir, 'crm.db');
if (!fs.existsSync(sqlitePath)) {
  console.error(`No SQLite database found at ${sqlitePath}`);
  process.exit(1);
}
if ((await value<number>('SELECT COUNT(*) FROM users')) > 0) {
  console.error('The target database already has employees. Import only into an empty database.');
  await disconnect();
  process.exit(1);
}

const source = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const sourceTables = new Set(source.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all() as string[]);

// SQLite stored UTC timestamps as "YYYY-MM-DD HH:MM:SS"; mark them as UTC for Postgres.
const toParam = (v: unknown): Param =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(' ', 'T')}Z` : (v as Param);

await tx(async () => {
  for (const table of TABLES) {
    if (!sourceTables.has(table)) continue;
    const targetColumns = new Set(
      await column<string>('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
        [table],
      ),
    );
    const rows = source.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const cols = Object.keys(row).filter((c) => targetColumns.has(c));
      await run(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => toParam(row[c])),
      );
    }
    // Continue numbering after the imported ids (tables with a generated id only; sessions use text ids).
    const sequence = targetColumns.has('id') ? await value<string | null>(`SELECT pg_get_serial_sequence(?, 'id')`, [table]) : null;
    if (sequence && rows.length) {
      await run(`SELECT setval(?::regclass, (SELECT MAX(id) FROM ${table}))`, [sequence]);
    }
    console.log(`${table}: ${rows.length}`);
  }
  for (const id of await column<number>('SELECT id FROM clients')) await reindexClient(id);
});

const filesDir = path.join(config.dataDir, 'files');
const files = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).filter((f) => /^[a-f0-9-]{36}\.bin$/.test(f)) : [];
for (const name of files) await putEncryptedFile(name, fs.readFileSync(path.join(filesDir, name)));
console.log(`files: ${files.length}`);

source.close();
await disconnect();
console.log('Import finished.');
