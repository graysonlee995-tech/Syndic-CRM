import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import {
  audit,
  createClient,
  createDocument,
  createLoyalty,
  deleteLoyalty,
  DOCUMENT_TYPES,
  getClient,
  getDocument,
  getLoyalty,
  listClientOptions,
  listDocuments,
  listLoyalty,
  moveToTrash,
  searchClients,
  updateClient,
  updateLoyalty,
} from '../db/repo.js';
import { getCompany } from '../db/companies.js';
import { currentUser, requireRole } from '../auth/session.js';
import { todayInTz } from '../lib/dates.js';
import { removeFile } from '../lib/files.js';
import { HttpError, parseId } from '../lib/http.js';
import { parseSearch } from '../lib/search.js';
import { clientSchema, documentSchema, loyaltySchema, optDate, optId, optText, pagingSchema, sortSchema } from './schemas.js';
import { storeUpload, upload } from './uploads.js';

/** Travellers. Stored in the `clients` table; mounted at /api/travellers and /api/clients. */
export const clientsRouter = Router();

const searchSchema = pagingSchema.merge(sortSchema).extend({
  q: z.string().max(200).optional().default(''),
  dob: optDate,
  nationality: optText(80),
  docType: z.enum(DOCUMENT_TYPES).optional(),
  companyId: optId,
});

async function assertCompany(companyId: number | null): Promise<void> {
  if (companyId !== null && !(await getCompany(companyId))) throw new HttpError(400, 'company_id: company not found');
}

async function requireClient(rawId: unknown) {
  const client = await getClient(parseId(rawId));
  if (!client) throw new HttpError(404, 'Traveller not found');
  return client;
}

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
    companyId: query.companyId,
    sort: query.sort ?? null,
    dir: query.dir,
    today: todayInTz(config.timezone),
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  res.json({ clients: rows, total, page: query.page, pageSize: query.pageSize });
});

clientsRouter.get('/options', async (_req, res) => {
  res.json({ travellers: await listClientOptions() });
});

clientsRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const input = clientSchema.parse(req.body);
  await assertCompany(input.company_id);
  const id = await createClient(input, user.id);
  await audit(user, 'client_created', 'client', id, `${input.first_name} ${input.last_name}`);
  res.status(201).json({ client: await getClient(id) });
});

clientsRouter.get('/:id', async (req, res) => {
  const client = await requireClient(req.params.id);
  await audit(currentUser(req), 'client_viewed', 'client', client.id);
  res.json({ client, documents: await listDocuments(client.id), loyalty: await listLoyalty(client.id) });
});

clientsRouter.put('/:id', async (req, res) => {
  const { id } = await requireClient(req.params.id);
  const input = clientSchema.parse(req.body);
  await assertCompany(input.company_id);
  await updateClient(id, input);
  await audit(currentUser(req), 'client_updated', 'client', id);
  res.json({ client: await getClient(id) });
});

/** Moves the traveller to the trash. Documents and trip history are kept until it is emptied. */
clientsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const client = await requireClient(req.params.id);
  await moveToTrash('client', client.id);
  await audit(currentUser(req), 'client_trashed', 'client', client.id, `${client.first_name} ${client.last_name}`);
  res.json({ ok: true });
});

clientsRouter.post('/:id/documents', upload.single('file'), async (req, res) => {
  const { id: clientId } = await requireClient(req.params.id);
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

// ---------------------------------------------------------------- frequent flyer memberships

async function requireLoyalty(clientId: number, rawId: unknown) {
  const membership = await getLoyalty(parseId(rawId));
  if (!membership || membership.client_id !== clientId) throw new HttpError(404, 'Membership not found');
  return membership;
}

clientsRouter.post('/:id/loyalty', async (req, res) => {
  const { id: clientId } = await requireClient(req.params.id);
  const input = loyaltySchema.parse(req.body);
  const id = await createLoyalty(clientId, input);
  await audit(currentUser(req), 'loyalty_added', 'client', clientId, `${input.airline} ${input.member_number}`);
  res.status(201).json({ membership: await getLoyalty(id) });
});

clientsRouter.put('/:id/loyalty/:loyaltyId', async (req, res) => {
  const { id: clientId } = await requireClient(req.params.id);
  const { id } = await requireLoyalty(clientId, req.params.loyaltyId);
  const input = loyaltySchema.parse(req.body);
  await updateLoyalty(id, input);
  await audit(currentUser(req), 'loyalty_updated', 'client', clientId, `${input.airline} ${input.member_number}`);
  res.json({ membership: await getLoyalty(id) });
});

clientsRouter.delete('/:id/loyalty/:loyaltyId', async (req, res) => {
  const { id: clientId } = await requireClient(req.params.id);
  const membership = await requireLoyalty(clientId, req.params.loyaltyId);
  await deleteLoyalty(membership.id);
  await audit(currentUser(req), 'loyalty_removed', 'client', clientId, `${membership.airline} ${membership.member_number}`);
  res.json({ ok: true });
});
