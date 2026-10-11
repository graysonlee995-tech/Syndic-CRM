import { column, insert, one, query, run, tx, value } from './index.js';
import { likePattern, orderBy, updateRow, type Bindable, type SortDir, type StoredFile } from './repo.js';

export interface CompanyInput {
  name: string;
  primary_contact: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  country: string | null;
  notes: string | null;
}

export interface CompanyRow extends CompanyInput {
  id: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const COMPANY_FIELDS = ['name', 'primary_contact', 'phone', 'email', 'address_line', 'city', 'country', 'notes'] as const;

export function createCompany(input: CompanyInput, userId: number): Promise<number> {
  return insert(
    `INSERT INTO companies (${COMPANY_FIELDS.join(', ')}, created_by)
     VALUES (${COMPANY_FIELDS.map((f) => '@' + f).join(', ')}, @created_by)`,
    { ...input, created_by: userId },
  );
}

export function updateCompany(id: number, input: CompanyInput): Promise<void> {
  return updateRow('companies', id, { ...input }, COMPANY_FIELDS);
}

/** Trashed companies are hidden unless `includeDeleted` is set. */
export function getCompany(id: number, includeDeleted = false): Promise<CompanyRow | undefined> {
  return one<CompanyRow>('SELECT * FROM companies WHERE id = ? AND (deleted_at IS NULL OR ?::boolean)', [id, includeDeleted]);
}

/**
 * Permanently deletes the company and its documents; returns stored file names to remove from storage.
 * Travellers and trips keep their records; their company link is cleared by the foreign key.
 */
export function purgeCompany(id: number): Promise<string[]> {
  return tx(async () => {
    const files = await column<string>('SELECT file_name FROM company_documents WHERE company_id = ?', [id]);
    await run('DELETE FROM companies WHERE id = ?', [id]);
    return files;
  });
}

export function listCompanyOptions(): Promise<{ id: number; name: string }[]> {
  return query<{ id: number; name: string }>('SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY lower(name)');
}

export interface CompanySearch {
  q: string;
  sort: string | null;
  dir: SortDir;
  today: string;
  limit: number;
  offset: number;
}

export interface CompanyListRow extends CompanyRow {
  traveller_count: number;
  upcoming_trips: number;
}

const COMPANY_SORTS: Record<string, string> = {
  name: 'lower(name) {dir}, id',
  id: 'id {dir}',
  contact: 'primary_contact IS NULL, lower(primary_contact) {dir}, id',
  city: 'city IS NULL, lower(city) {dir}, lower(country) {dir}, id',
  travellers: 'traveller_count {dir}, lower(name)',
  upcoming: 'upcoming_trips {dir}, lower(name)',
  updated: 'updated_at {dir}, id',
};

const SEARCHABLE = ['co.name', 'co.primary_contact', 'co.email', 'co.phone', 'co.city', 'co.country'];

export async function searchCompanies(s: CompanySearch): Promise<{ rows: CompanyListRow[]; total: number }> {
  const where: string[] = ['co.deleted_at IS NULL'];
  const params: Record<string, Bindable> = {};
  s.q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .forEach((word, i) => {
      params[`q${i}`] = likePattern(word);
      where.push(`(${SEARCHABLE.map((col) => `${col} ILIKE @q${i} ESCAPE '\\'`).join(' OR ')})`);
    });
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await query<CompanyListRow>(
    `SELECT * FROM (
       SELECT co.*,
         (SELECT COUNT(*) FROM clients c WHERE c.company_id = co.id AND c.deleted_at IS NULL) AS traveller_count,
         (SELECT COUNT(*) FROM trips t WHERE t.company_id = co.id AND t.deleted_at IS NULL
            AND t.status != 'cancelled' AND t.departure_date > @today) AS upcoming_trips
       FROM companies co ${whereSql}
     ) s
     ORDER BY ${orderBy(COMPANY_SORTS, s.sort, s.dir, 'name')}
     LIMIT @limit OFFSET @offset`,
    { ...params, today: s.today, limit: s.limit, offset: s.offset },
  );
  const total = await value<number>(`SELECT COUNT(*) FROM companies co ${whereSql}`, params);
  return { rows, total };
}

// ---------------------------------------------------------------- company documents (optional)

export interface CompanyDocumentRow extends StoredFile {
  id: number;
  company_id: number;
  title: string;
  uploaded_by: number | null;
  created_at: string;
}

export function listCompanyDocuments(companyId: number) {
  return query(
    `SELECT d.id, d.company_id, d.title, d.original_name, d.mime_type, d.size, d.created_at, u.name AS uploaded_by_name
     FROM company_documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.company_id = ? ORDER BY d.id DESC`,
    [companyId],
  );
}

export function getCompanyDocument(companyId: number, id: number): Promise<CompanyDocumentRow | undefined> {
  return one<CompanyDocumentRow>('SELECT * FROM company_documents WHERE id = ? AND company_id = ?', [id, companyId]);
}

export function createCompanyDocument(companyId: number, title: string, file: StoredFile, userId: number): Promise<number> {
  return tx(async () => {
    const id = await insert(
      `INSERT INTO company_documents (company_id, title, file_name, original_name, mime_type, size, uploaded_by)
       VALUES (@company_id, @title, @file_name, @original_name, @mime_type, @size, @uploaded_by)`,
      { company_id: companyId, title, ...file, uploaded_by: userId },
    );
    await run('UPDATE companies SET updated_at = now() WHERE id = ?', [companyId]);
    return id;
  });
}

export async function deleteCompanyDocument(companyId: number, id: number): Promise<void> {
  await run('DELETE FROM company_documents WHERE id = ? AND company_id = ?', [id, companyId]);
}
