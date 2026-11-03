import { Router } from 'express';
import { z } from 'zod';
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
  timezone,
  PASSENGER_CATEGORIES,
  setClientActive,
} from '../db/repo.js';
import { getCompany } from '../db/companies.js';
import { contactSummaries, listContacts, replaceContacts } from '../db/contacts.js';
import { EXPORT_LIMIT, exportFileName, sendWorkbook } from '../lib/excel.js';
import { tx } from '../db/index.js';
import { reindexClient } from '../db/repo.js';
import { currentUser } from '../auth/session.js';
import { todayInTz } from '../lib/dates.js';
import { removeFile } from '../lib/files.js';
import { HttpError, parseId } from '../lib/http.js';
import { parseSearch } from '../lib/search.js';
import { clientSchema, contactsSchema, documentSchema, loyaltySchema, optDate, optId, optText, pagingSchema, sortSchema } from './schemas.js';
import { storeUpload, upload } from './uploads.js';
import { requirePermission, requireAnyPermission } from '../auth/permissions.js';

/** Travellers. Stored in the `clients` table; mounted at /api/travellers and /api/clients. */
export const clientsRouter = Router();

const searchSchema = pagingSchema.merge(sortSchema).extend({
  q: z.string().max(200).optional().default(''),
  dob: optDate,
  nationality: optText(80),
  docType: z.enum(DOCUMENT_TYPES).optional(),
  companyId: optId,
  category: z.enum(PASSENGER_CATEGORIES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

async function assertCompanies(companyIds: number[]): Promise<void> {
  for (const id of companyIds) if (!(await getCompany(id))) throw new HttpError(400, `company_ids: company #${id} not found`);
}

async function requireClient(rawId: unknown) {
  const client = await getClient(parseId(rawId));
  if (!client) throw new HttpError(404, 'Traveller not found');
  return client;
}

/** Runs the Travellers list's filters; the Excel export uses the same ones. */
async function searchFrom(query: z.infer<typeof searchSchema>, limit: number, offset: number) {
  const parsed = parseSearch(query.q);
  // A date typed in the search box that contradicts the date-of-birth filter matches nobody.
  if (parsed.dob && query.dob && parsed.dob !== query.dob) return { rows: [], total: 0 };
  return searchClients({
    terms: parsed.terms,
    dob: query.dob ?? parsed.dob,
    nationality: query.nationality,
    docType: query.docType ?? null,
    category: query.category ?? null,
    status: query.status ?? null,
    companyId: query.companyId,
    sort: query.sort ?? null,
    dir: query.dir,
    today: todayInTz(timezone()),
    limit,
    offset,
  });
}

clientsRouter.get('/', requirePermission('travellers', 'view'), async (req, res) => {
  const query = searchSchema.parse(req.query);
  const { rows, total } = await searchFrom(query, query.pageSize, (query.page - 1) * query.pageSize);
  res.json({ clients: rows, total, page: query.page, pageSize: query.pageSize });
});

/** The filtered list as an Excel file, including extra phones and addresses. */
clientsRouter.get('/export', requirePermission('travellers', 'export'), async (req, res) => {
  const query = searchSchema.parse(req.query);
  const { rows } = await searchFrom(query, EXPORT_LIMIT, 0);
  const extras = await contactSummaries('client', rows.map((c) => c.id));
  const search = query.q ? `; search "${query.q}"` : '';
  await audit(currentUser(req), 'travellers_exported', 'client', null, `${rows.length} traveller(s)${search}`);
  await sendWorkbook(res, exportFileName('travellers', todayInTz(timezone())), [
    {
      name: 'Travellers',
      columns: [
        { header: 'ID', key: 'code', width: 10 },
        { header: 'Given name', key: 'first_name', width: 16 },
        { header: 'Last name', key: 'last_name', width: 16 },
        { header: 'Companies', key: 'company_name', width: 30 },
        { header: 'Nationality', key: 'nationality', width: 14 },
        { header: 'Date of birth', key: 'date_of_birth', width: 14 },
        { header: 'Passenger', key: 'passenger', width: 11 },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'Gender', key: 'gender' },
        { header: 'Phone', key: 'phone', width: 18 },
        { header: 'Extra emails', key: 'extra_emails', width: 30 },
        { header: 'Extra phones', key: 'extra_phones', width: 30 },
        { header: 'Email', key: 'email', width: 26 },
        { header: 'Address', key: 'address_line', width: 28 },
        { header: 'State', key: 'state' },
        { header: 'City', key: 'city' },
        { header: 'Country', key: 'country' },
        { header: 'Extra addresses', key: 'extra_addresses', width: 36 },
        { header: 'Documents', key: 'document_count' },
        { header: 'Earliest document expiry', key: 'earliest_expiry', width: 22 },
        { header: 'Upcoming trips', key: 'upcoming_trips', width: 15 },
        { header: 'Seat', key: 'seat_preference' },
        { header: 'Cabin', key: 'cabin_preference' },
        { header: 'Meal', key: 'meal_preference' },
        { header: 'Special requirements', key: 'special_requirements', width: 24 },
        { header: 'Notes', key: 'notes', width: 30 },
        { header: 'Sabre Entries', key: 'sabre_entry', width: 40 },
        { header: 'Last updated', key: 'updated_at', width: 22 },
      ],
      rows: rows.map((c) => ({
        ...c,
        code: `T-${String(c.id).padStart(4, '0')}`,
        passenger: c.category === 'unknown' ? '' : c.category[0].toUpperCase() + c.category.slice(1),
        status: c.is_active ? 'Active' : 'Inactive',
        extra_emails: extras.get(c.id)?.emails,
        extra_phones: extras.get(c.id)?.phones,
        extra_addresses: extras.get(c.id)?.addresses,
      })),
    },
  ]);
});

clientsRouter.get('/options', requireAnyPermission(['trips', 'view'], ['travellers', 'view'], ['companies', 'view'], ['open_credits', 'view'], ['quality', 'view']), async (_req, res) => {
  res.json({ travellers: await listClientOptions() });
});

clientsRouter.post('/', requirePermission('travellers', 'add'), async (req, res) => {
  const user = currentUser(req);
  const input = clientSchema.parse(req.body);
  const { emails, phones, addresses } = contactsSchema.parse(req.body);
  await assertCompanies(input.company_ids);
  const id = await tx(async () => {
    const newId = await createClient(input, user.id);
    await replaceContacts({ kind: 'client', id: newId }, phones, addresses, emails);
    await reindexClient(newId);
    return newId;
  });
  await audit(user, 'client_created', 'client', id, `${input.first_name} ${input.last_name}`);
  res.status(201).json({ client: await getClient(id) });
});

clientsRouter.get('/:id', requirePermission('travellers', 'view'), async (req, res) => {
  const client = await requireClient(req.params.id);
  await audit(currentUser(req), 'client_viewed', 'client', client.id);
  res.json({
    client,
    contacts: await listContacts({ kind: 'client', id: client.id }),
    documents: await listDocuments(client.id),
    loyalty: await listLoyalty(client.id),
  });
});

/** Makes the traveller active or inactive; inactive travellers' documents raise no expiry alerts. */
clientsRouter.put('/:id/status', requirePermission('travellers', 'edit'), async (req, res) => {
  const client = await requireClient(req.params.id);
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  await setClientActive(client.id, active);
  await audit(currentUser(req), active ? 'client_activated' : 'client_deactivated', 'client', client.id, `${client.first_name} ${client.last_name}`);
  res.json({ client: await getClient(client.id) });
});

clientsRouter.put('/:id', requirePermission('travellers', 'edit'), async (req, res) => {
  const { id } = await requireClient(req.params.id);
  const input = clientSchema.parse(req.body);
  const { emails, phones, addresses } = contactsSchema.parse(req.body);
  await assertCompanies(input.company_ids);
  await tx(async () => {
    await updateClient(id, input);
    await replaceContacts({ kind: 'client', id }, phones, addresses, emails);
    await reindexClient(id);
  });
  await audit(currentUser(req), 'client_updated', 'client', id);
  res.json({ client: await getClient(id) });
});

/** Moves the traveller to the trash. Documents and trip history are kept until it is emptied. */
clientsRouter.delete('/:id', requirePermission('travellers', 'delete'), async (req, res) => {
  const client = await requireClient(req.params.id);
  await moveToTrash('client', client.id);
  await audit(currentUser(req), 'client_trashed', 'client', client.id, `${client.first_name} ${client.last_name}`);
  res.json({ ok: true });
});

clientsRouter.post('/:id/documents', requirePermission('travellers', 'edit'), upload.single('file'), async (req, res) => {
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

clientsRouter.post('/:id/loyalty', requirePermission('travellers', 'edit'), async (req, res) => {
  const { id: clientId } = await requireClient(req.params.id);
  const input = loyaltySchema.parse(req.body);
  const id = await createLoyalty(clientId, input);
  await audit(currentUser(req), 'loyalty_added', 'client', clientId, `${input.airline} ${input.member_number}`);
  res.status(201).json({ membership: await getLoyalty(id) });
});

clientsRouter.put('/:id/loyalty/:loyaltyId', requirePermission('travellers', 'edit'), async (req, res) => {
  const { id: clientId } = await requireClient(req.params.id);
  const { id } = await requireLoyalty(clientId, req.params.loyaltyId);
  const input = loyaltySchema.parse(req.body);
  await updateLoyalty(id, input);
  await audit(currentUser(req), 'loyalty_updated', 'client', clientId, `${input.airline} ${input.member_number}`);
  res.json({ membership: await getLoyalty(id) });
});

clientsRouter.delete('/:id/loyalty/:loyaltyId', requirePermission('travellers', 'edit'), async (req, res) => {
  const { id: clientId } = await requireClient(req.params.id);
  const membership = await requireLoyalty(clientId, req.params.loyaltyId);
  await deleteLoyalty(membership.id);
  await audit(currentUser(req), 'loyalty_removed', 'client', clientId, `${membership.airline} ${membership.member_number}`);
  res.json({ ok: true });
});
