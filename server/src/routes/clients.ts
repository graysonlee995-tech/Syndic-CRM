import { Router } from 'express';
import { z } from 'zod';
import {
  audit,
  createClient,
  createDocument,
  deleteClient,
  DOCUMENT_TYPES,
  getClient,
  getDocument,
  listDocuments,
  searchClients,
  updateClient,
} from '../db/repo.js';
import { currentUser, requireRole } from '../auth/session.js';
import { removeFile } from '../lib/files.js';
import { HttpError, parseId } from '../lib/http.js';
import { parseSearch } from '../lib/search.js';
import { clientSchema, documentSchema, optDate, optText, pagingSchema } from './schemas.js';
import { storeUpload, upload } from './uploads.js';

export const clientsRouter = Router();

const searchSchema = pagingSchema.extend({
  q: z.string().max(200).optional().default(''),
  dob: optDate,
  nationality: optText(80),
  docType: z.enum(DOCUMENT_TYPES).optional(),
});

clientsRouter.get('/', async (req, res) => {
  const query = searchSchema.parse(req.query);
  const parsed = parseSearch(query.q);
  if (parsed.dob && query.dob && parsed.dob !== query.dob) {
    res.json({ clients: [], total: 0, page: query.page, pageSize: query.pageSize });
    return;
  }
  const { rows, total } = await searchClients({
    terms: parsed.terms,
    dob: query.dob ?? parsed.dob,
    nationality: query.nationality,
    docType: query.docType ?? null,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  res.json({ clients: rows, total, page: query.page, pageSize: query.pageSize });
});

clientsRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const input = clientSchema.parse(req.body);
  const id = await createClient(input, user.id);
  await audit(user, 'client_created', 'client', id, `${input.first_name} ${input.last_name}`);
  res.status(201).json({ client: await getClient(id) });
});

clientsRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const client = await getClient(id);
  if (!client) throw new HttpError(404, 'Client not found');
  await audit(currentUser(req), 'client_viewed', 'client', id);
  res.json({ client, documents: await listDocuments(id) });
});

clientsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!(await getClient(id))) throw new HttpError(404, 'Client not found');
  const input = clientSchema.parse(req.body);
  await updateClient(id, input);
  await audit(currentUser(req), 'client_updated', 'client', id);
  res.json({ client: await getClient(id) });
});

clientsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  const client = await getClient(id);
  if (!client) throw new HttpError(404, 'Client not found');
  const files = await deleteClient(id);
  await Promise.all(files.map((f) => removeFile(f)));
  await audit(currentUser(req), 'client_deleted', 'client', id, `${client.first_name} ${client.last_name}`);
  res.json({ ok: true });
});

clientsRouter.post('/:id/documents', upload.single('file'), async (req, res) => {
  const clientId = parseId(req.params.id);
  if (!(await getClient(clientId))) throw new HttpError(404, 'Client not found');
  const input = documentSchema.parse(req.body);
  const user = currentUser(req);
  const file = await storeUpload(req.file);
  try {
    const id = await createDocument(clientId, input, file, user.id);
    await audit(user, 'document_added', 'document', id, `${input.type} for client #${clientId}`);
    res.status(201).json({ document: await getDocument(id) });
  } catch (err) {
    await removeFile(file?.file_name);
    throw err;
  }
});
