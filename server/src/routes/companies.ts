import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { audit, moveToTrash } from '../db/repo.js';
import {
  createCompany,
  createCompanyDocument,
  deleteCompanyDocument,
  getCompany,
  getCompanyDocument,
  listCompanyDocuments,
  listCompanyOptions,
  searchCompanies,
  updateCompany,
} from '../db/companies.js';
import { currentUser, requireRole } from '../auth/session.js';
import { todayInTz } from '../lib/dates.js';
import { readFile, removeFile } from '../lib/files.js';
import { contentDisposition, HttpError, parseId } from '../lib/http.js';
import { companySchema, contactsSchema, pagingSchema, sortSchema } from './schemas.js';
import { contactSummaries, listContacts, replaceContacts } from '../db/contacts.js';
import { EXPORT_LIMIT, exportFileName, sendWorkbook } from '../lib/excel.js';
import { tx } from '../db/index.js';
import { storeUpload, upload } from './uploads.js';

/**
 * Companies. Their travellers and trips are listed through /api/travellers?companyId=
 * and /api/trips?companyId=, so every view reads the same records.
 */
export const companiesRouter = Router();

async function requireCompany(rawId: unknown) {
  const company = await getCompany(parseId(rawId));
  if (!company) throw new HttpError(404, 'Company not found');
  return company;
}

/** The Companies list's filters; the Excel export uses the same ones. */
const listSchema = pagingSchema.merge(sortSchema).extend({ q: z.string().max(200).optional().default('') });

const searchFrom = (query: z.infer<typeof listSchema>, limit: number, offset: number) =>
  searchCompanies({ q: query.q, sort: query.sort ?? null, dir: query.dir, today: todayInTz(config.timezone), limit, offset });

companiesRouter.get('/', async (req, res) => {
  const query = listSchema.parse(req.query);
  const { rows, total } = await searchFrom(query, query.pageSize, (query.page - 1) * query.pageSize);
  res.json({ companies: rows, total, page: query.page, pageSize: query.pageSize });
});

/** The filtered list as an Excel file, including extra phones and addresses. */
companiesRouter.get('/export', async (req, res) => {
  const query = listSchema.parse(req.query);
  const { rows } = await searchFrom(query, EXPORT_LIMIT, 0);
  const extras = await contactSummaries('company', rows.map((c) => c.id));
  const search = query.q ? `; search "${query.q}"` : '';
  await audit(currentUser(req), 'companies_exported', 'company', null, `${rows.length} company(ies)${search}`);
  await sendWorkbook(res, exportFileName('companies', todayInTz(config.timezone)), [
    {
      name: 'Companies',
      columns: [
        { header: 'ID', key: 'code', width: 10 },
        { header: 'Company name', key: 'name', width: 30 },
        { header: 'Primary contact', key: 'primary_contact', width: 22 },
        { header: 'Phone', key: 'phone', width: 18 },
        { header: 'Extra phones', key: 'extra_phones', width: 30 },
        { header: 'Email', key: 'email', width: 26 },
        { header: 'Address', key: 'address_line', width: 28 },
        { header: 'State', key: 'state' },
        { header: 'City', key: 'city' },
        { header: 'Country', key: 'country' },
        { header: 'Extra addresses', key: 'extra_addresses', width: 36 },
        { header: 'Travellers', key: 'traveller_count' },
        { header: 'Upcoming trips', key: 'upcoming_trips', width: 15 },
        { header: 'Notes', key: 'notes', width: 30 },
        { header: 'Last updated', key: 'updated_at', width: 22 },
      ],
      rows: rows.map((c) => ({
        ...c,
        code: `C-${String(c.id).padStart(4, '0')}`,
        extra_phones: extras.get(c.id)?.phones,
        extra_addresses: extras.get(c.id)?.addresses,
      })),
    },
  ]);
});

companiesRouter.get('/options', async (_req, res) => {
  res.json({ companies: await listCompanyOptions() });
});

companiesRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const input = companySchema.parse(req.body);
  const { phones, addresses } = contactsSchema.parse(req.body);
  const id = await tx(async () => {
    const newId = await createCompany(input, user.id);
    await replaceContacts({ kind: 'company', id: newId }, phones, addresses);
    return newId;
  });
  await audit(user, 'company_created', 'company', id, input.name);
  res.status(201).json({ company: await getCompany(id) });
});

companiesRouter.get('/:id', async (req, res) => {
  const company = await requireCompany(req.params.id);
  await audit(currentUser(req), 'company_viewed', 'company', company.id);
  res.json({
    company,
    contacts: await listContacts({ kind: 'company', id: company.id }),
    documents: await listCompanyDocuments(company.id),
  });
});

companiesRouter.put('/:id', async (req, res) => {
  const { id } = await requireCompany(req.params.id);
  const input = companySchema.parse(req.body);
  const { phones, addresses } = contactsSchema.parse(req.body);
  await tx(async () => {
    await updateCompany(id, input);
    await replaceContacts({ kind: 'company', id }, phones, addresses);
  });
  await audit(currentUser(req), 'company_updated', 'company', id);
  res.json({ company: await getCompany(id) });
});

/** Moves the company to the trash. Its travellers and trips stay linked and can still be opened. */
companiesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const company = await requireCompany(req.params.id);
  await moveToTrash('company', company.id);
  await audit(currentUser(req), 'company_trashed', 'company', company.id, company.name);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- company documents (optional)

companiesRouter.post('/:id/documents', upload.single('file'), async (req, res) => {
  const { id: companyId } = await requireCompany(req.params.id);
  const { title } = z.object({ title: z.string().trim().max(200).optional().default('') }).parse(req.body);
  const file = await storeUpload(req.file);
  if (!file) throw new HttpError(400, 'Choose a file to upload');
  try {
    const id = await createCompanyDocument(companyId, title || file.original_name, file, currentUser(req).id);
    await audit(currentUser(req), 'company_document_added', 'company', companyId, title || file.original_name);
    res.status(201).json({ document: { id } });
  } catch (err) {
    await removeFile(file.file_name);
    throw err;
  }
});

companiesRouter.get('/:id/documents/:docId/file', async (req, res) => {
  const { id: companyId } = await requireCompany(req.params.id);
  const doc = await getCompanyDocument(companyId, parseId(req.params.docId));
  if (!doc) throw new HttpError(404, 'Document not found');
  const download = req.query.download === '1';
  await audit(currentUser(req), download ? 'file_downloaded' : 'file_viewed', 'company_document', doc.id);
  const body = await readFile(doc.file_name);
  res.set({
    'Content-Type': doc.mime_type ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', doc.original_name || `company-document-${doc.id}`),
    'Cache-Control': 'private, no-store',
  });
  res.send(body);
});

companiesRouter.delete('/:id/documents/:docId', async (req, res) => {
  const { id: companyId } = await requireCompany(req.params.id);
  const doc = await getCompanyDocument(companyId, parseId(req.params.docId));
  if (!doc) throw new HttpError(404, 'Document not found');
  await deleteCompanyDocument(companyId, doc.id);
  await removeFile(doc.file_name);
  await audit(currentUser(req), 'company_document_removed', 'company', companyId, doc.title);
  res.json({ ok: true });
});
