import crypto from 'node:crypto';
import { column, insert, one, query, run, tx, value, type Param } from './index.js';
import { compact, normalize } from '../lib/search.js';

// ---------------------------------------------------------------- helpers

export type Bindable = Param;

function toBindable(v: unknown): Bindable {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v as Bindable;
}

export type SortDir = 'asc' | 'desc';

/**
 * ORDER BY clause from a whitelist. `{dir}` in each entry is replaced by the
 * direction, so user input never reaches the SQL directly. List queries wrap
 * their SELECT in a subquery `s`, so entries can use the column aliases.
 */
export function orderBy(sorts: Record<string, string>, key: string | null | undefined, dir: SortDir, fallback: string): string {
  const template = (key && sorts[key]) || sorts[fallback];
  return template.replaceAll('{dir}', dir === 'desc' ? 'DESC' : 'ASC');
}

/** ILIKE pattern for a substring match, with wildcards in the input escaped (use with ESCAPE '\'). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

export async function updateRow(
  table: string,
  id: number,
  patch: Record<string, unknown>,
  allowed: readonly string[],
  touch = true,
): Promise<void> {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (!keys.length) return;
  const params: Record<string, Bindable> = { id };
  for (const k of keys) params[k] = toBindable(patch[k]);
  const sets = keys.map((k) => `${k} = @${k}`);
  if (touch) sets.push('updated_at = now()');
  await run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id`, params);
}

/** Removes the internal search column from rows sent to the browser. */
function publicRow<T extends { search_text?: unknown }>(row: T): Omit<T, 'search_text'> {
  const { search_text: _s, ...rest } = row;
  return rest;
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
  return one<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export function getUserByEmail(email: string): Promise<UserRow | undefined> {
  return one<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', [email.trim()]);
}

export function listUsers(): Promise<UserRow[]> {
  return query<UserRow>('SELECT * FROM users ORDER BY is_active DESC, lower(name)');
}

export function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  receivesAlerts?: boolean;
}): Promise<number> {
  return insert('INSERT INTO users (name, email, password_hash, role, receives_alerts) VALUES (?, ?, ?, ?, ?)', [
    input.name,
    input.email.trim(),
    input.passwordHash,
    input.role,
    input.receivesAlerts ? 1 : 0,
  ]);
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
  return value<number>(`SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1`);
}

export function alertRecipients(): Promise<string[]> {
  return column<string>('SELECT email FROM users WHERE is_active = 1 AND receives_alerts = 1');
}

// ---------------------------------------------------------------- sessions

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await run('INSERT INTO sessions (id, user_id) VALUES (?, ?)', [hashToken(token), userId]);
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
     WHERE s.id = ? AND s.last_seen_at > now() - make_interval(hours => ?)`,
    [hashToken(token), idleHours],
  );
  if (!row) return undefined;
  const { session_id, session_last_seen, ...user } = row;
  return { sessionId: session_id, lastSeenAt: session_last_seen, user };
}

export async function touchSession(sessionId: string): Promise<void> {
  await run('UPDATE sessions SET last_seen_at = now() WHERE id = ?', [sessionId]);
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await run('DELETE FROM sessions WHERE id = ?', [hashToken(token)]);
}

export async function deleteUserSessions(userId: number, exceptSessionId?: string): Promise<void> {
  await run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, exceptSessionId ?? '']);
}

export async function purgeIdleSessions(idleHours: number): Promise<void> {
  await run('DELETE FROM sessions WHERE last_seen_at <= now() - make_interval(hours => ?)', [idleHours]);
}

// ---------------------------------------------------------------- clients (shown as "Travellers")

export interface ClientInput {
  first_name: string;
  last_name: string;
  company_id: number | null;
  date_of_birth: string | null;
  gender: string | null;
  nationality: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  country: string | null;
  seat_preference: string | null;
  meal_preference: string | null;
  cabin_preference: string | null;
  special_requirements: string | null;
  notes: string | null;
}

export interface ClientRow extends ClientInput {
  id: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const CLIENT_FIELDS = [
  'first_name',
  'last_name',
  'company_id',
  'date_of_birth',
  'gender',
  'nationality',
  'phone',
  'email',
  'address_line',
  'city',
  'country',
  'seat_preference',
  'meal_preference',
  'cabin_preference',
  'special_requirements',
  'notes',
] as const;

/** Rebuilds the words the search box matches: name, address, phone, email and document numbers. */
export async function reindexClient(id: number): Promise<void> {
  const c = await one<ClientRow>('SELECT * FROM clients WHERE id = ?', [id]);
  if (!c) return;
  const numbers = await column<string>(
    'SELECT document_number FROM documents WHERE client_id = ? AND document_number IS NOT NULL',
    [id],
  );
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
  ];
  const text = normalize(parts.filter(Boolean).join(' '));
  await run('UPDATE clients SET search_text = ? WHERE id = ?', [text, id]);
}

export function createClient(input: ClientInput, userId: number): Promise<number> {
  return tx(async () => {
    const id = await insert(
      `INSERT INTO clients (${CLIENT_FIELDS.join(', ')}, created_by)
       VALUES (${CLIENT_FIELDS.map((f) => '@' + f).join(', ')}, @created_by)`,
      { ...input, created_by: userId },
    );
    await reindexClient(id);
    return id;
  });
}

export function updateClient(id: number, input: ClientInput): Promise<void> {
  return tx(async () => {
    await updateRow('clients', id, { ...input }, CLIENT_FIELDS);
    await reindexClient(id);
  });
}

export interface ClientWithCompany extends ClientRow {
  company_name: string | null;
}

/** Trashed travellers are hidden unless `includeDeleted` is set. */
export async function getClient(id: number, includeDeleted = false): Promise<ClientWithCompany | undefined> {
  const row = await one<ClientWithCompany & { search_text: string }>(
    `SELECT c.*, co.name AS company_name
     FROM clients c LEFT JOIN companies co ON co.id = c.company_id
     WHERE c.id = ? AND (c.deleted_at IS NULL OR ?::boolean)`,
    [id, includeDeleted],
  );
  return row && publicRow(row);
}

/** Permanently deletes the client and its documents; returns stored file names to remove from storage. */
export function purgeClient(id: number): Promise<string[]> {
  return tx(async () => {
    const files = await column<string>(
      'SELECT file_name FROM documents WHERE client_id = ? AND file_name IS NOT NULL',
      [id],
    );
    await run('DELETE FROM clients WHERE id = ?', [id]);
    return files;
  });
}

export interface ClientOption {
  id: number;
  first_name: string;
  last_name: string;
  company_id: number | null;
  company_name: string | null;
}

/** Options for pickers (traveller selects on trips, hotels, cars, cruises). */
export function listClientOptions(): Promise<ClientOption[]> {
  return query<ClientOption>(
    `SELECT c.id, c.first_name, c.last_name, c.company_id, co.name AS company_name
     FROM clients c LEFT JOIN companies co ON co.id = c.company_id
     WHERE c.deleted_at IS NULL
     ORDER BY lower(c.last_name), lower(c.first_name)`,
  );
}

export interface ClientSearch {
  terms: string[];
  dob: string | null;
  nationality: string | null;
  docType: string | null;
  companyId: number | null;
  sort: string | null;
  dir: SortDir;
  today: string;
  limit: number;
  offset: number;
}

export interface ClientListRow extends ClientWithCompany {
  document_count: number;
  earliest_expiry: string | null;
  upcoming_trips: number;
}

const CLIENT_SORTS: Record<string, string> = {
  name: 'lower(last_name) {dir}, lower(first_name) {dir}, id',
  id: 'id {dir}',
  company: 'company_name IS NULL, lower(company_name) {dir}, lower(last_name)',
  nationality: 'nationality IS NULL, lower(nationality) {dir}, lower(last_name)',
  dob: 'date_of_birth IS NULL, date_of_birth {dir}, id',
  expiry: 'earliest_expiry IS NULL, earliest_expiry {dir}, id',
  upcoming: 'upcoming_trips {dir}, lower(last_name)',
  updated: 'updated_at {dir}, id',
};

/** Trip counts below only include live, non-cancelled trips that have not started yet. */
const UPCOMING_TRIP = `t.deleted_at IS NULL AND t.status != 'cancelled' AND t.departure_date > @today`;

export async function searchClients(s: ClientSearch): Promise<{ rows: ClientListRow[]; total: number }> {
  const where: string[] = ['c.deleted_at IS NULL'];
  const params: Record<string, Bindable> = {};
  s.terms.forEach((term, i) => {
    where.push(`c.search_text LIKE @t${i} ESCAPE '\\'`);
    params[`t${i}`] = likePattern(term);
  });
  if (s.dob) {
    where.push('c.date_of_birth = @dob');
    params.dob = s.dob;
  }
  if (s.nationality) {
    where.push('lower(c.nationality) = lower(@nationality)');
    params.nationality = s.nationality;
  }
  if (s.docType) {
    where.push('EXISTS (SELECT 1 FROM documents d WHERE d.client_id = c.id AND d.type = @docType)');
    params.docType = s.docType;
  }
  if (s.companyId) {
    where.push('c.company_id = @companyId');
    params.companyId = s.companyId;
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await query<ClientListRow & { search_text: string }>(
    `SELECT * FROM (
       SELECT c.*, co.name AS company_name,
         (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id) AS document_count,
         (SELECT MIN(expiry_date) FROM documents d WHERE d.client_id = c.id AND d.expiry_date IS NOT NULL) AS earliest_expiry,
         (SELECT COUNT(*) FROM trip_travellers tt JOIN trips t ON t.id = tt.trip_id
          WHERE tt.client_id = c.id AND ${UPCOMING_TRIP}) AS upcoming_trips
       FROM clients c LEFT JOIN companies co ON co.id = c.company_id
       ${whereSql}
     ) s
     ORDER BY ${orderBy(CLIENT_SORTS, s.sort, s.dir, 'name')}
     LIMIT @limit OFFSET @offset`,
    { ...params, today: s.today, limit: s.limit, offset: s.offset },
  );
  const total = await value<number>(`SELECT COUNT(*) FROM clients c ${whereSql}`, params);
  return { rows: rows.map(publicRow) as ClientListRow[], total };
}

export function countClients(): Promise<number> {
  return value<number>('SELECT COUNT(*) FROM clients WHERE deleted_at IS NULL');
}

// ---------------------------------------------------------------- frequent flyer memberships

export interface LoyaltyInput {
  airline: string;
  programme: string | null;
  member_number: string;
  tier: string | null;
}

export interface LoyaltyRow extends LoyaltyInput {
  id: number;
  client_id: number;
  created_at: string;
  updated_at: string;
}

const LOYALTY_FIELDS = ['airline', 'programme', 'member_number', 'tier'] as const;

export function listLoyalty(clientId: number): Promise<LoyaltyRow[]> {
  return query<LoyaltyRow>('SELECT * FROM frequent_flyer_memberships WHERE client_id = ? ORDER BY lower(airline), id', [clientId]);
}

export function getLoyalty(id: number): Promise<LoyaltyRow | undefined> {
  return one<LoyaltyRow>('SELECT * FROM frequent_flyer_memberships WHERE id = ?', [id]);
}

export function createLoyalty(clientId: number, input: LoyaltyInput): Promise<number> {
  return insert(
    `INSERT INTO frequent_flyer_memberships (client_id, airline, programme, member_number, tier)
     VALUES (@client_id, @airline, @programme, @member_number, @tier)`,
    { client_id: clientId, ...input },
  );
}

export function updateLoyalty(id: number, input: LoyaltyInput): Promise<void> {
  return updateRow('frequent_flyer_memberships', id, { ...input }, LOYALTY_FIELDS);
}

export async function deleteLoyalty(id: number): Promise<void> {
  await run('DELETE FROM frequent_flyer_memberships WHERE id = ?', [id]);
}

// ---------------------------------------------------------------- trash

export const TRASHABLE = { trip: 'trips', company: 'companies', client: 'clients' } as const;
export type TrashKind = keyof typeof TRASHABLE;

export async function moveToTrash(kind: TrashKind, id: number): Promise<void> {
  await run(`UPDATE ${TRASHABLE[kind]} SET deleted_at = now() WHERE id = ? AND deleted_at IS NULL`, [id]);
}

export async function restoreFromTrash(kind: TrashKind, id: number): Promise<void> {
  await run(`UPDATE ${TRASHABLE[kind]} SET deleted_at = NULL, updated_at = now() WHERE id = ?`, [id]);
}

export async function isTrashed(kind: TrashKind, id: number): Promise<boolean> {
  return Boolean(await one(`SELECT 1 FROM ${TRASHABLE[kind]} WHERE id = ? AND deleted_at IS NOT NULL`, [id]));
}

export interface TrashRow {
  kind: TrashKind;
  id: number;
  label: string;
  detail: string | null;
  deleted_at: string;
}

export function listTrash(): Promise<TrashRow[]> {
  return query<TrashRow>(
    `SELECT 'trip' AS kind, id, name AS label, reference AS detail, deleted_at FROM trips WHERE deleted_at IS NOT NULL
     UNION ALL
     SELECT 'company', id, name, city, deleted_at FROM companies WHERE deleted_at IS NOT NULL
     UNION ALL
     SELECT 'client', id, first_name || ' ' || last_name, email, deleted_at FROM clients WHERE deleted_at IS NOT NULL
     ORDER BY deleted_at DESC`,
  );
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
  return query<DocumentRow>(
    'SELECT * FROM documents WHERE client_id = ? ORDER BY expiry_date IS NULL, expiry_date, id',
    [clientId],
  );
}

export function getDocument(id: number): Promise<DocumentRow | undefined> {
  return one<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
}

export function createDocument(clientId: number, input: DocumentInput, file: StoredFile | null, userId: number): Promise<number> {
  return tx(async () => {
    const id = await insert(
      `INSERT INTO documents (client_id, type, document_number, issuing_country, issue_date, expiry_date, notes,
         file_name, original_name, mime_type, size, uploaded_by)
       VALUES (@client_id, @type, @document_number, @issuing_country, @issue_date, @expiry_date, @notes,
         @file_name, @original_name, @mime_type, @size, @uploaded_by)`,
      {
        client_id: clientId,
        ...input,
        file_name: file?.file_name ?? null,
        original_name: file?.original_name ?? null,
        mime_type: file?.mime_type ?? null,
        size: file?.size ?? null,
        uploaded_by: userId,
      },
    );
    await reindexClient(clientId);
    return id;
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
  return tx(async () => {
    const before = await getDocument(id);
    if (!before) return;
    await updateRow('documents', id, { ...input, ...(file ? { ...file, uploaded_by: userId } : {}) }, DOCUMENT_FIELDS);
    // A renewed document starts its alert cycle again.
    if (before.expiry_date !== input.expiry_date) {
      await run('DELETE FROM alert_log WHERE document_id = ?', [id]);
    }
    await reindexClient(before.client_id);
  });
}

export function deleteDocument(id: number): Promise<void> {
  return tx(async () => {
    const doc = await getDocument(id);
    if (!doc) return;
    await run('DELETE FROM documents WHERE id = ?', [id]);
    await reindexClient(doc.client_id);
  });
}

export function countDocuments(): Promise<number> {
  return value<number>('SELECT COUNT(*) FROM documents d JOIN clients c ON c.id = d.client_id WHERE c.deleted_at IS NULL');
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
  return query<ExpiringDocument>(
    `SELECT d.id, d.client_id, d.type, d.document_number, d.expiry_date, c.first_name, c.last_name
     FROM documents d JOIN clients c ON c.id = d.client_id
     WHERE d.expiry_date IS NOT NULL AND d.expiry_date <= ? AND c.deleted_at IS NULL
     ORDER BY d.expiry_date, lower(c.last_name)`,
    [until],
  );
}

// ---------------------------------------------------------------- alerts

export async function sentAlertKeys(): Promise<Set<string>> {
  const rows = await query<{ document_id: number; threshold_days: number }>('SELECT document_id, threshold_days FROM alert_log');
  return new Set(rows.map((r) => `${r.document_id}:${r.threshold_days}`));
}

export function recordAlerts(alerts: { documentId: number; threshold: number }[]): Promise<void> {
  return tx(async () => {
    for (const a of alerts) {
      await run('INSERT INTO alert_log (document_id, threshold_days) VALUES (?, ?) ON CONFLICT DO NOTHING', [
        a.documentId,
        a.threshold,
      ]);
    }
  });
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
  return query<BirthdayClient>(
    `SELECT id, first_name, last_name, date_of_birth, phone, email
     FROM clients WHERE date_of_birth IS NOT NULL AND deleted_at IS NULL`,
  );
}

export async function sentBirthdayKeys(): Promise<Set<string>> {
  const rows = await query<{ client_id: number; year: number }>('SELECT client_id, year FROM birthday_log');
  return new Set(rows.map((r) => `${r.client_id}:${r.year}`));
}

export function recordBirthdays(entries: { clientId: number; year: number }[]): Promise<void> {
  return tx(async () => {
    for (const e of entries) {
      await run('INSERT INTO birthday_log (client_id, year) VALUES (?, ?) ON CONFLICT DO NOTHING', [e.clientId, e.year]);
    }
  });
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

/** Settings rows holding encrypted secrets; never part of getSettings(). */
const SECRET_PREFIX = 'secret:';

export async function getSettings(): Promise<Settings> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key NOT LIKE '${SECRET_PREFIX}%'`,
  );
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** An encrypted secret (see lib/secrets.ts), or null when not set. */
export async function getSecret(name: string): Promise<string | null> {
  return (await value<string | undefined>('SELECT value FROM settings WHERE key = ?', [SECRET_PREFIX + name])) ?? null;
}

export async function setSecret(name: string, encrypted: string | null): Promise<void> {
  if (encrypted === null) {
    await run('DELETE FROM settings WHERE key = ?', [SECRET_PREFIX + name]);
    return;
  }
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
    SECRET_PREFIX + name,
    encrypted,
  ]);
}

export function saveSettings(settings: Settings): Promise<void> {
  return tx(async () => {
    for (const [key, v] of Object.entries(settings)) {
      await run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(v)],
      );
    }
  });
}

// ---------------------------------------------------------------- audit log

export async function audit(
  user: { id: number; name: string } | null,
  action: string,
  entity?: string,
  entityId?: number | null,
  details?: string,
): Promise<void> {
  await run('INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)', [
    user?.id ?? null,
    user?.name ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    details ?? null,
  ]);
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
  const rows = await query<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
  const total = await value<number>('SELECT COUNT(*) FROM audit_log');
  return { rows, total };
}

/**
 * Change history of one record (views are left out). A traveller's history
 * also includes changes to their documents.
 */
export function listActivity(entity: TrashKind, entityId: number, limit = 200): Promise<AuditRow[]> {
  const documents =
    entity === 'client'
      ? `OR (entity = 'document' AND entity_id IN (SELECT id FROM documents WHERE client_id = @id))`
      : '';
  return query<AuditRow>(
    `SELECT * FROM audit_log
     WHERE ((entity = @entity AND entity_id = @id) ${documents})
       AND action NOT LIKE '%\\_viewed' ESCAPE '\\' AND action != 'file_downloaded'
     ORDER BY id DESC LIMIT @limit`,
    { entity, id: entityId, limit },
  );
}
