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
import { companySchema, pagingSchema, sortSchema } from './schemas.js';
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

companiesRouter.get('/', async (req, res) => {
  const query = pagingSchema
    .merge(sortSchema)
    .extend({ q: z.string().max(200).optional().default('') })
    .parse(req.query);
  const { rows, total } = await searchCompanies({
    q: query.q,
    sort: query.sort ?? null,
    dir: query.dir,
    today: todayInTz(config.timezone),
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  res.json({ companies: rows, total, page: query.page, pageSize: query.pageSize });
});

companiesRouter.get('/options', async (_req, res) => {
  res.json({ companies: await listCompanyOptions() });
});

companiesRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const input = companySchema.parse(req.body);
  const id = await createCompany(input, user.id);
  await audit(user, 'company_created', 'company', id, input.name);
  res.status(201).json({ company: await getCompany(id) });
});

companiesRouter.get('/:id', async (req, res) => {
  const company = await requireCompany(req.params.id);
  await audit(currentUser(req), 'company_viewed', 'company', company.id);
  res.json({ company, documents: await listCompanyDocuments(company.id) });
});

companiesRouter.put('/:id', async (req, res) => {
  const { id } = await requireCompany(req.params.id);
  const input = companySchema.parse(req.body);
  await updateCompany(id, input);
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
