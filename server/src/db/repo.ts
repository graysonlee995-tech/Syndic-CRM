import crypto from 'node:crypto';
import { one, q, tx, type Queryable } from './index.js';
import { NOW_SQL } from './schema.js';
import { compact, tokenize } from '../lib/search.js';

// ---------------------------------------------------------------- helpers

type Bindable = string | number | null;

function toBindable(value: unknown): Bindable {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value as Bindable;
}

async function updateRow(
  table: string,
  id: number,
  patch: Record<string, unknown>,
  allowed: readonly string[],
  touch = true,
  db?: Queryable,
) {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (!keys.length) return;
  const params: Bindable[] = [id];
  const sets = keys.map((k) => {
    params.push(toBindable(patch[k]));
    return `${k} = $${params.length}`;
  });
  if (touch) sets.push(`updated_at = ${NOW_SQL}`);
  await q(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1`, params, db);
}

/** Postgres returns COUNT(*) as a string; cast in SQL and read it here. */
async function count(sql: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: number }>(sql, params);
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------- users

export type Role = 'admin' | 'staff';

export interface UserRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  is_active: number;
  receives_alerts: number;
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface PublicUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
  receives_alerts: boolean;
  totp_enabled: boolean;
  locked: boolean;
  created_at: string;
  last_login_at: string | null;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    is_active: Boolean(u.is_active),
    receives_alerts: Boolean(u.receives_alerts),
    totp_enabled: Boolean(u.totp_secret),
    locked: Boolean(u.locked_until && Date.parse(u.locked_until) > Date.now()),
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

export function getUserById(id: number): Promise<UserRow | undefined> {
  return one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
}

export function getUserByEmail(email: string): Promise<UserRow | undefined> {
  return one<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
}

export function listUsers(): Promise<UserRow[]> {
  return q<UserRow>('SELECT * FROM users ORDER BY is_active DESC, lower(name), id');
}

export async function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  receivesAlerts?: boolean;
}): Promise<number> {
  const row = await one<{ id: number }>(
    `INSERT INTO users (name, email, password_hash, role, receives_alerts)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.name, input.email.trim(), input.passwordHash, input.role, input.receivesAlerts ? 1 : 0],
  );
  return row!.id;
}

export type UserPatch = Partial<
  Pick<
    UserRow,
    | 'name'
    | 'email'
    | 'password_hash'
    | 'role'
    | 'totp_secret'
    | 'totp_pending_secret'
    | 'failed_logins'
    | 'locked_until'
    | 'last_login_at'
  > & { is_active: boolean; receives_alerts: boolean }
>;

const USER_FIELDS = [
  'name',
  'email',
  'password_hash',
  'role',
  'totp_secret',
  'totp_pending_secret',
  'is_active',
  'receives_alerts',
  'failed_logins',
  'locked_until',
  'last_login_at',
] as const;

export function updateUser(id: number, patch: UserPatch): Promise<void> {
  return updateRow('users', id, patch, USER_FIELDS, false);
}

export function countActiveAdmins(): Promise<number> {
  return count(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active = 1`);
}

export async function alertRecipients(): Promise<string[]> {
  const rows = await q<{ email: string }>('SELECT email FROM users WHERE is_active = 1 AND receives_alerts = 1');
  return rows.map((r) => r.email);
}

// ---------------------------------------------------------------- sessions

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** UTC text timestamp `hours` ago, in the same format as the stored columns. */
const hoursAgoSql = (param: string) =>
  `to_char(timezone('utc', now()) - make_interval(hours => ${param}), 'YYYY-MM-DD HH24:MI:SS')`;

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO sessions (id, user_id) VALUES ($1, $2)', [hashToken(token), userId]);
  return token;
}

export interface SessionLookup {
  sessionId: string;
  lastSeenAt: string;
  user: UserRow;
}

/** Returns the session if it exists and has been used within `idleHours`. */
export async function getActiveSession(token: string, idleHours: number): Promise<SessionLookup | undefined> {
  const row = await one<UserRow & { session_id: string; session_last_seen: string }>(
    `SELECT s.id AS session_id, s.last_seen_at AS session_last_seen, u.*
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.last_seen_at > ${hoursAgoSql('$2::int')}`,
    [hashToken(token), idleHours],
  );
  if (!row) return undefined;
  const { session_id, session_last_seen, ...user } = row;
  return { sessionId: session_id, lastSeenAt: session_last_seen, user };
}

export async function touchSession(sessionId: string): Promise<void> {
  await q(`UPDATE sessions SET last_seen_at = ${NOW_SQL} WHERE id = $1`, [sessionId]);
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await q('DELETE FROM sessions WHERE id = $1', [hashToken(token)]);
}

export async function deleteUserSessions(userId: number, exceptSessionId?: string): Promise<void> {
  await q('DELETE FROM sessions WHERE user_id = $1 AND id != $2', [userId, exceptSessionId ?? '']);
}

export async function purgeIdleSessions(idleHours: number): Promise<void> {
  await q(`DELETE FROM sessions WHERE last_seen_at <= ${hoursAgoSql('$1::int')}`, [idleHours]);
}

// ---------------------------------------------------------------- clients

export interface ClientInput {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  gender: string | null;
  nationality: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  country: string | null;
  notes: string | null;
}

export interface ClientRow extends ClientInput {
  id: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

const CLIENT_FIELDS = [
  'first_name',
  'last_name',
  'date_of_birth',
  'gender',
  'nationality',
  'phone',
  'email',
  'address_line',
  'city',
  'country',
  'notes',
] as const;

/** Columns returned to the app (everything except the internal search tokens). */
const CLIENT_COLUMNS = ['id', ...CLIENT_FIELDS, 'created_by', 'created_at', 'updated_at'];
const clientCols = (alias = '') => CLIENT_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');

/** Rebuilds the words the search box matches against: name, address, contact and document numbers. */
export async function reindexClient(id: number, db?: Queryable): Promise<void> {
  const c = await one<ClientRow>(`SELECT ${clientCols()} FROM clients WHERE id = $1`, [id], db);
  if (!c) return;
  const numbers = (
    await q<{ document_number: string }>(
      'SELECT document_number FROM documents WHERE client_id = $1 AND document_number IS NOT NULL',
      [id],
      db,
    )
  ).map((r) => r.document_number);
  const parts = [
    c.first_name,
    c.last_name,
    c.address_line,
    c.city,
    c.country,
    c.phone,
    c.phone ? compact(c.phone) : null,
    c.email,
    ...numbers.flatMap((n) => [n, compact(n)]),
  ].filter(Boolean) as string[];
  const tokens = [...new Set(parts.flatMap(tokenize))];
  await q('UPDATE clients SET search_tokens = $2 WHERE id = $1', [id, tokens], db);
}

export function createClient(input: ClientInput, userId: number): Promise<number> {
  return tx(async (db) => {
    const values = CLIENT_FIELDS.map((f) => input[f]);
    const row = await one<{ id: number }>(
      `INSERT INTO clients (${CLIENT_FIELDS.join(', ')}, created_by)
       VALUES (${CLIENT_FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${CLIENT_FIELDS.length + 1})
       RETURNING id`,
      [...values, userId],
      db,
    );
    await reindexClient(row!.id, db);
    return row!.id;
  });
}

export function updateClient(id: number, input: ClientInput): Promise<void> {
  return tx(async (db) => {
    await updateRow('clients', id, { ...input }, CLIENT_FIELDS, true, db);
    await reindexClient(id, db);
  });
}

export function getClient(id: number): Promise<ClientRow | undefined> {
  return one<ClientRow>(`SELECT ${clientCols()} FROM clients WHERE id = $1`, [id]);
}

/** Deletes the client and its documents; returns stored file names to remove from storage. */
export function deleteClient(id: number): Promise<string[]> {
  return tx(async (db) => {
    const files = await q<{ file_name: string }>(
      'SELECT file_name FROM documents WHERE client_id = $1 AND file_name IS NOT NULL',
      [id],
      db,
    );
    await q('DELETE FROM clients WHERE id = $1', [id], db);
    return files.map((f) => f.file_name);
  });
}

export interface ClientSearch {
  terms: string[];
  dob: string | null;
  nationality: string | null;
  docType: string | null;
  limit: number;
  offset: number;
}

export interface ClientListRow extends ClientRow {
  document_count: number;
  earliest_expiry: string | null;
}

/** Escapes LIKE wildcards so a search term is matched literally. */
const likePrefix = (term: string) => term.replace(/[\\%_]/g, (m) => '\\' + m) + '%';

export async function searchClients(s: ClientSearch): Promise<{ rows: ClientListRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  for (const term of s.terms) {
    where.push(`EXISTS (SELECT 1 FROM unnest(c.search_tokens) t WHERE t LIKE ${add(likePrefix(term))})`);
  }
  if (s.dob) where.push(`c.date_of_birth = ${add(s.dob)}`);
  if (s.nationality) where.push(`lower(c.nationality) = lower(${add(s.nationality)})`);
  if (s.docType) {
    where.push(`EXISTS (SELECT 1 FROM documents d WHERE d.client_id = c.id AND d.type = ${add(s.docType)})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filterParams = [...params];

  const rows = await q<ClientListRow>(
    `SELECT ${clientCols('c')},
       (SELECT COUNT(*)::int FROM documents d WHERE d.client_id = c.id) AS document_count,
       (SELECT MIN(expiry_date) FROM documents d WHERE d.client_id = c.id AND d.expiry_date IS NOT NULL) AS earliest_expiry
     FROM clients c ${whereSql}
     ORDER BY lower(c.last_name), lower(c.first_name), c.id
     LIMIT ${add(s.limit)} OFFSET ${add(s.offset)}`,
    params,
  );
  const total = await count(`SELECT COUNT(*)::int AS n FROM clients c ${whereSql}`, filterParams);
  return { rows, total };
}

export function countClients(): Promise<number> {
  return count('SELECT COUNT(*)::int AS n FROM clients');
}

// ---------------------------------------------------------------- documents

export const DOCUMENT_TYPES = ['passport', 'driving_licence', 'national_id', 'visa', 'residence_permit', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface DocumentInput {
  type: DocumentType;
  document_number: string | null;
  issuing_country: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  notes: string | null;
}

export interface StoredFile {
  file_name: string;
  original_name: string;
  mime_type: string;
  size: number;
}

export interface DocumentRow extends DocumentInput {
  id: number;
  client_id: number;
  file_name: string | null;
  original_name: string | null;
  mime_type: string | null;
  size: number | null;
  uploaded_by: number | null;
  created_at: string;
  updated_at: string;
}

export function listDocuments(clientId: number): Promise<DocumentRow[]> {
  return q<DocumentRow>(
    'SELECT * FROM documents WHERE client_id = $1 ORDER BY expiry_date IS NULL, expiry_date, id',
    [clientId],
  );
}

export function getDocument(id: number, db?: Queryable): Promise<DocumentRow | undefined> {
  return one<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id], db);
}

export function createDocument(
  clientId: number,
  input: DocumentInput,
  file: StoredFile | null,
  userId: number,
): Promise<number> {
  return tx(async (db) => {
    const row = await one<{ id: number }>(
      `INSERT INTO documents (client_id, type, document_number, issuing_country, issue_date, expiry_date, notes,
         file_name, original_name, mime_type, size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        clientId,
        input.type,
        input.document_number,
        input.issuing_country,
        input.issue_date,
        input.expiry_date,
        input.notes,
        file?.file_name ?? null,
        file?.original_name ?? null,
        file?.mime_type ?? null,
        file?.size ?? null,
        userId,
      ],
      db,
    );
    await reindexClient(clientId, db);
    return row!.id;
  });
}

const DOCUMENT_FIELDS = [
  'type',
  'document_number',
  'issuing_country',
  'issue_date',
  'expiry_date',
  'notes',
  'file_name',
  'original_name',
  'mime_type',
  'size',
  'uploaded_by',
] as const;

export function updateDocument(id: number, input: DocumentInput, file: StoredFile | null, userId: number): Promise<void> {
  return tx(async (db) => {
    const before = await getDocument(id, db);
    if (!before) return;
    await updateRow(
      'documents',
      id,
      { ...input, ...(file ? { ...file, uploaded_by: userId } : {}) },
      DOCUMENT_FIELDS,
      true,
      db,
    );
    // A renewed document starts its alert cycle again.
    if (before.expiry_date !== input.expiry_date) {
      await q('DELETE FROM alert_log WHERE document_id = $1', [id], db);
    }
    await reindexClient(before.client_id, db);
  });
}

export function deleteDocument(id: number): Promise<void> {
  return tx(async (db) => {
    const doc = await getDocument(id, db);
    if (!doc) return;
    await q('DELETE FROM documents WHERE id = $1', [id], db);
    await reindexClient(doc.client_id, db);
  });
}

export function countDocuments(): Promise<number> {
  return count('SELECT COUNT(*)::int AS n FROM documents');
}

export interface ExpiringDocument {
  id: number;
  client_id: number;
  type: DocumentType;
  document_number: string | null;
  expiry_date: string;
  first_name: string;
  last_name: string;
}

/** Documents with an expiry date on or before `until` (including already expired ones). */
export function documentsExpiringBy(until: string): Promise<ExpiringDocument[]> {
  return q<ExpiringDocument>(
    `SELECT d.id, d.client_id, d.type, d.document_number, d.expiry_date, c.first_name, c.last_name
     FROM documents d JOIN clients c ON c.id = d.client_id
     WHERE d.expiry_date IS NOT NULL AND d.expiry_date <= $1
     ORDER BY d.expiry_date, lower(c.last_name), d.id`,
    [until],
  );
}

// ---------------------------------------------------------------- alerts

export async function sentAlertKeys(): Promise<Set<string>> {
  const rows = await q<{ document_id: number; threshold_days: number }>(
    'SELECT document_id, threshold_days FROM alert_log',
  );
  return new Set(rows.map((r) => `${r.document_id}:${r.threshold_days}`));
}

export async function recordAlerts(alerts: { documentId: number; threshold: number }[]): Promise<void> {
  if (!alerts.length) return;
  await q(
    `INSERT INTO alert_log (document_id, threshold_days)
     SELECT * FROM unnest($1::int[], $2::int[]) ON CONFLICT DO NOTHING`,
    [alerts.map((a) => a.documentId), alerts.map((a) => a.threshold)],
  );
}

// ---------------------------------------------------------------- birthdays

export interface BirthdayClient {
  id: number;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  phone: string | null;
  email: string | null;
}

export function clientsWithBirthdays(): Promise<BirthdayClient[]> {
  return q<BirthdayClient>(
    `SELECT id, first_name, last_name, date_of_birth, phone, email
     FROM clients WHERE date_of_birth IS NOT NULL`,
  );
}

export async function sentBirthdayKeys(): Promise<Set<string>> {
  const rows = await q<{ client_id: number; year: number }>('SELECT client_id, year FROM birthday_log');
  return new Set(rows.map((r) => `${r.client_id}:${r.year}`));
}

export async function recordBirthdays(entries: { clientId: number; year: number }[]): Promise<void> {
  if (!entries.length) return;
  await q(
    `INSERT INTO birthday_log (client_id, year)
     SELECT * FROM unnest($1::int[], $2::int[]) ON CONFLICT DO NOTHING`,
    [entries.map((e) => e.clientId), entries.map((e) => e.year)],
  );
}

// ---------------------------------------------------------------- settings

export interface Settings {
  alertThresholds: number[];
  alertTime: string;
  birthdayReminders: boolean;
  birthdayDaysAhead: number;
}

const DEFAULT_SETTINGS: Settings = {
  alertThresholds: [90, 30, 7, 0],
  alertTime: '08:00',
  birthdayReminders: true,
  birthdayDaysAhead: 7,
};

export async function getSettings(): Promise<Settings> {
  const rows = await q<{ key: string; value: string }>('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const entries = Object.entries(settings);
  await q(
    `INSERT INTO settings (key, value) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [entries.map(([k]) => k), entries.map(([, v]) => JSON.stringify(v))],
  );
}

// ---------------------------------------------------------------- audit log

export async function audit(
  user: { id: number; name: string } | null,
  action: string,
  entity?: string,
  entityId?: number | null,
  details?: string,
): Promise<void> {
  await q(
    'INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
    [user?.id ?? null, user?.name ?? null, action, entity ?? null, entityId ?? null, details ?? null],
  );
}

export interface AuditRow {
  id: number;
  user_id: number | null;
  user_name: string | null;
  action: string;
  entity: string | null;
  entity_id: number | null;
  details: string | null;
  at: string;
}

export async function listAudit(limit: number, offset: number): Promise<{ rows: AuditRow[]; total: number }> {
  const rows = await q<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
  const total = await count('SELECT COUNT(*)::int AS n FROM audit_log');
  return { rows, total };
}
