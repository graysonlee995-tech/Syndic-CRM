/**
 * One-time copy of your local data (the embedded database in DATA_DIR/pgdata
 * and the encrypted files in DATA_DIR/files) into Supabase. Record ids are
 * kept, so links between records stay intact.
 *
 *   1. Stop the local app (npm run dev), which keeps the local database open.
 *   2. Put DATABASE_URL in .env (and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to use Storage for files).
 *   3. npm run copy-to-supabase -w server
 *
 * Refuses to run if Supabase already has employees, so it cannot create duplicates.
 * Files are copied still encrypted, so the server needs the same FILE_ENCRYPTION_KEY.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { config } from '../config.js';
import { column, disconnect, run, tx, value, type Param } from '../db/index.js';
import { TABLES } from '../db/schema.js';
import { putEncryptedFile, usingRemoteStorage } from '../lib/files.js';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!config.databaseUrl || !usingRemoteStorage) {
  fail('Set DATABASE_URL in .env first (see .env.example).');
}
const localDir = path.join(config.dataDir, 'pgdata');
if (!fs.existsSync(localDir)) fail(`No local database found at ${localDir}`);

// Connecting also creates the tables in Supabase if they are not there yet.
if ((await value<number>('SELECT COUNT(*) FROM users')) > 0) {
  await disconnect();
  fail('Supabase already has employees. Copy only into an empty database.');
}

const local = new PGlite(localDir);

await tx(async () => {
  for (const table of TABLES) {
    const { rows } = await local.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
    for (const row of rows) {
      const cols = Object.keys(row);
      await run(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => {
          const v = row[c];
          return (v instanceof Date ? v.toISOString() : v) as Param;
        }),
      );
    }
    // Continue numbering after the copied ids (tables with a generated id only).
    const sequence = await value<string | null>(
      `SELECT pg_get_serial_sequence(?, 'id') WHERE EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'id' AND is_identity = 'YES')`,
      [table, table],
    );
    if (sequence && rows.length) await run(`SELECT setval(?::regclass, (SELECT MAX(id) FROM ${table}))`, [sequence]);
    console.log(`${table}: ${rows.length}`);
  }
});
await local.close();

// Only files the database still refers to; deleted records' leftovers are skipped.
const referenced = new Set<string>();
for (const table of ['documents', 'trip_documents', 'company_documents']) {
  for (const name of await column<string>(`SELECT file_name FROM ${table} WHERE file_name IS NOT NULL`)) referenced.add(name);
}
const filesDir = path.join(config.dataDir, 'files');
let copied = 0;
for (const name of referenced) {
  const file = path.join(filesDir, name);
  if (!fs.existsSync(file)) {
    console.warn(`missing local file ${name}`);
    continue;
  }
  await putEncryptedFile(name, fs.readFileSync(file));
  copied++;
}
console.log(`files: ${copied}`);

await disconnect();
console.log('Copied local data to Supabase.');
