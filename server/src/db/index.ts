import pg from 'pg';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';

const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Supabase requires TLS; its certificate chain is not in Node's default store.
  ssl: isLocal || process.env.PGSSL === 'disable' ? undefined : { rejectUnauthorized: false },
  // Serverless functions each hold their own small pool; keep it small for Supabase's connection limit.
  max: Number(process.env.PG_POOL_MAX ?? 3),
  idleTimeoutMillis: 10_000,
});

// Every connection works in the private "crm" schema. Set it once per connection, before first use.
const prepared = new WeakSet<pg.PoolClient>();
async function checkout(): Promise<pg.PoolClient> {
  const client = await pool.connect();
  if (!prepared.has(client)) {
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS crm; SET search_path TO crm');
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
    prepared.add(client);
  }
  return client;
}
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

/** A client inside a transaction. Without one, queries take a pooled connection. */
export type Queryable = pg.PoolClient;

let ready: Promise<void> | null = null;

/** Creates the schema once per process. Every repo call waits for it. */
export function ensureSchema(): Promise<void> {
  ready ??= (async () => {
    const client = await checkout();
    try {
      await client.query(SCHEMA);
    } finally {
      client.release();
    }
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = [], db?: Queryable) {
  await ensureSchema();
  if (db) return (await db.query(sql, params)).rows as T[];
  const client = await checkout();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    client.release();
  }
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = [], db?: Queryable) {
  return (await q<T>(sql, params, db))[0] as T | undefined;
}

/** Runs `fn` in a transaction and returns its result. */
export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await checkout();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
