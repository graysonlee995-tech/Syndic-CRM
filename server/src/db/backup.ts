import { column, query, run, tx, value, type Param } from './index.js';
import { reindexClient } from './repo.js';
import { TABLES } from './schema.js';

/**
 * Whole-database backup as JSON: every record of every table except sign-in
 * sessions. Uploaded files are not included (they are stored encrypted in
 * Supabase Storage, the database's stored_files table or DATA_DIR/files); the
 * records keep pointing at them by name.
 */

export const BACKUP_FORMAT = 'syndic-crm-backup';
const SKIP = new Set(['sessions']);

export interface Backup {
  format: typeof BACKUP_FORMAT;
  /** Number of schema migrations the source database had applied. */
  schema_version: number;
  created_at: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportDatabase(): Promise<Backup> {
  const tables: Backup['tables'] = {};
  for (const table of TABLES) {
    if (SKIP.has(table)) continue;
    tables[table] = await query(`SELECT * FROM ${table} ORDER BY 1`);
  }
  return {
    format: BACKUP_FORMAT,
    schema_version: await value<number>('SELECT COALESCE(MAX(version), 0) FROM schema_migrations'),
    created_at: new Date().toISOString(),
    tables,
  };
}

/** Checks a parsed file looks like one of our backups; returns a readable problem or null. */
export function backupProblem(data: unknown): string | null {
  const b = data as Partial<Backup> | null;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) return 'This is not a Syndic CRM backup file.';
  if (!b.tables || typeof b.tables !== 'object') return 'The backup file has no data.';
  const unknown = Object.keys(b.tables).filter((t) => !TABLES.includes(t));
  if (unknown.length) return `The backup contains tables this version does not know (${unknown.join(', ')}). Update Syndic CRM first.`;
  if (!Array.isArray(b.tables.users) || b.tables.users.length === 0) return 'The backup has no employees, so nobody could sign in after importing it.';
  for (const [t, rows] of Object.entries(b.tables)) if (!Array.isArray(rows)) return `The backup's "${t}" data is damaged.`;
  return null;
}

/**
 * Replaces ALL data with the backup's, in one transaction: if anything fails
 * nothing changes. Everyone is signed out (sessions are cleared).
 * Returns the number of records imported per table.
 */
export async function importDatabase(backup: Backup): Promise<Record<string, number>> {
  return tx(async () => {
    await run(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const rows = backup.tables[table] ?? [];
      counts[table] = rows.length;
      if (!rows.length) continue;
      const existing = new Set(
        await column<string>('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', [table]),
      );
      // Columns this database has; anything else (from another version) is ignored.
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => existing.has(c));
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const values: Param[] = [];
        const tuples = batch.map((row) => `(${cols.map((c) => (values.push((row[c] ?? null) as Param), '?')).join(', ')})`);
        await run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, values);
      }
      // Continue numbering after the imported ids.
      const sequence = existing.has('id') ? await value<string | null>(`SELECT pg_get_serial_sequence(?, 'id')`, [table]) : null;
      if (sequence) await run(`SELECT setval(?::regclass, (SELECT MAX(id) FROM ${table}))`, [sequence]);
    }
    for (const id of await column<number>('SELECT id FROM clients')) await reindexClient(id);
    return counts;
  });
}
