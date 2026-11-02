import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { config } from '../config.js';
import { migrate } from './schema.js';

/**
 * Database access. In production this is Postgres (Supabase) via DATABASE_URL.
 * Without DATABASE_URL (local development, tests) an embedded Postgres
 * (PGlite) is used, stored in DATA_DIR/pgdata, or in memory for tests.
 *
 * Queries take `?` placeholders with an array, or `@name` placeholders with an object.
 */

export type Param = string | number | boolean | null;
export type Params = readonly Param[] | Record<string, Param | undefined>;

export interface Runner {
  query(text: string, values: Param[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
}

interface Driver extends Runner {
  transaction<T>(fn: (runner: Runner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const INT8 = 20;
const TIMESTAMPTZ = 1184;

/** Postgres timestamptz text (2026-10-09 21:06:26.123+00) -> ISO 8601 UTC. */
export function timestampToIso(value: string): string {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2})(?::?(\d{2}))?$/);
  if (!m) return new Date(value).toISOString();
  const zone = m[3] === 'Z' ? 'Z' : `${m[3]}:${m[4] ?? '00'}`;
  return new Date(`${m[1]}T${m[2]}${zone}`).toISOString();
}

function postgresDriver(url: string): Driver {
  pg.types.setTypeParser(INT8, (v) => parseInt(v, 10));
  pg.types.setTypeParser(TIMESTAMPTZ, timestampToIso);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    // Supabase requires TLS. Its pooler certificate is not in Node's default CA list.
    ssl: local ? undefined : { rejectUnauthorized: false },
    // Each serverless instance keeps its own pool; keep them small so many
    // instances fit within Supabase's connection limit.
    max: config.onVercel ? 2 : 10,
    idleTimeoutMillis: config.onVercel ? 5_000 : 30_000,
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err));

  const runnerFor = (client: pg.Pool | pg.PoolClient): Runner => ({
    query: async (text, values) => {
      const r = await client.query(text, values);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    exec: async (sql) => {
      await client.query(sql);
    },
  });

  return {
    ...runnerFor(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(runnerFor(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dataDir: string | undefined): Promise<Driver> {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  // Loaded only when needed, so production (Supabase) never loads the embedded database.
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir, {
    parsers: { [INT8]: (v: string) => parseInt(v, 10), [TIMESTAMPTZ]: timestampToIso },
  });

  const runnerFor = (target: Pick<PGlite, 'query' | 'exec'>): Runner => ({
    query: async (text, values) => {
      const r = await target.query<Record<string, unknown>>(text, values);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: async (sql) => {
      await target.exec(sql);
    },
  });

  return {
    ...runnerFor(db),
    transaction: (fn) => db.transaction((tx) => fn(runnerFor(tx))),
    close: () => db.close(),
  };
}

let driverPromise: Promise<Driver> | null = null;

function driver(): Promise<Driver> {
  driverPromise ??= (async () => {
    const d = config.databaseUrl
      ? postgresDriver(config.databaseUrl)
      : await pgliteDriver(process.env.NODE_ENV === 'test' ? undefined : path.join(config.dataDir, 'pgdata'));
    await migrate(d);
    return d;
  })().catch((err) => {
    // Let the next request try again instead of failing forever.
    driverPromise = null;
    throw err;
  });
  return driverPromise;
}

/** Opens the database and applies pending migrations. Called on start-up; queries also do it lazily. */
export async function connect(): Promise<void> {
  await driver();
}

export async function disconnect(): Promise<void> {
  if (!driverPromise) return;
  const d = await driverPromise;
  driverPromise = null;
  await d.close();
}

// ---------------------------------------------------------------- placeholders

/** Converts `?` (array) or `@name` (object) placeholders to Postgres $1, $2, ... */
export function toPositional(sql: string, params: Params = []): { text: string; values: Param[] } {
  if (Array.isArray(params)) {
    let i = 0;
    const text = sql.replace(/\?/g, () => `$${++i}`);
    if (i !== params.length) throw new Error(`Query has ${i} placeholders but ${params.length} values`);
    return { text, values: [...params] };
  }
  const named = params as Record<string, Param | undefined>;
  const values: Param[] = [];
  const index = new Map<string, number>();
  const text = sql.replace(/@([A-Za-z_]\w*)/g, (_m, name: string) => {
    if (!(name in named)) throw new Error(`Missing query parameter @${name}`);
    if (!index.has(name)) {
      values.push(named[name] ?? null);
      index.set(name, values.length);
    }
    return `$${index.get(name)}`;
  });
  return { text, values };
}

// ---------------------------------------------------------------- queries

const txStore = new AsyncLocalStorage<Runner>();

async function runner(): Promise<Runner> {
  return txStore.getStore() ?? (await driver());
}

/** All rows. */
export async function query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]> {
  const { text, values } = toPositional(sql, params);
  return (await (await runner()).query(text, values)).rows as T[];
}

/** The first row, if any. */
export async function one<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}

/** The first column of the first row. */
export async function value<T>(sql: string, params?: Params): Promise<T> {
  const row = await one(sql, params);
  return (row ? Object.values(row)[0] : undefined) as T;
}

/** The first column of every row. */
export async function column<T>(sql: string, params?: Params): Promise<T[]> {
  return (await query(sql, params)).map((r) => Object.values(r)[0] as T);
}

/** Runs a statement; returns the number of affected rows. */
export async function run(sql: string, params?: Params): Promise<number> {
  const { text, values } = toPositional(sql, params);
  return (await (await runner()).query(text, values)).rowCount;
}

/** Runs an INSERT ... RETURNING id and returns the id. */
export async function insert(sql: string, params?: Params): Promise<number> {
  const row = await one<{ id: number }>(`${sql} RETURNING id`, params);
  return row!.id;
}

/**
 * Runs `fn` in a transaction. Every query made inside it (including in nested
 * helpers) joins the same transaction; a nested call joins the outer one.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn();
  return (await driver()).transaction((r) => txStore.run(r, fn));
}
