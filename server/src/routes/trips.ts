import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { audit, getClient, moveToTrash } from '../db/repo.js';
import { getCompany } from '../db/companies.js';
import {
  BOOKING_KINDS,
  createBooking,
  createTicket,
  createTrip,
  createTripDocument,
  deleteBooking,
  deleteTicket,
  deleteTripDocument,
  getBooking,
  getTicket,
  getTrip,
  getTripDetail,
  getTripDocument,
  hasTicket,
  resolveTicket,
  searchTrips,
  TRIP_FILTERS,
  tripTravellerIds,
  updateBooking,
  updateTicket,
  updateTrip,
  type BookingKind,
} from '../db/trips.js';
import { currentUser, requireRole } from '../auth/session.js';
import { todayInTz } from '../lib/dates.js';
import { readFile, removeFile } from '../lib/files.js';
import { contentDisposition, HttpError, parseId } from '../lib/http.js';
import { bookingSchemas, idList, optId, pagingSchema, resolutionSchema, sortSchema, ticketSchema, tripSchema } from './schemas.js';
import { storeUpload, upload } from './uploads.js';

/** Trips and everything booked on them. Companies and travellers link to these same records. */
export const tripsRouter = Router();

const today = () => todayInTz(config.timezone);

async function requireTrip(rawId: unknown) {
  const trip = await getTrip(parseId(rawId), today());
  if (!trip) throw new HttpError(404, 'Trip not found');
  return trip;
}

async function assertLinks(input: { company_id: number | null; traveller_ids: number[] }): Promise<void> {
  if (input.company_id !== null && !(await getCompany(input.company_id))) {
    throw new HttpError(400, 'company_id: company not found');
  }
  for (const id of input.traveller_ids) {
    if (!(await getClient(id))) throw new HttpError(400, `traveller_ids: traveller #${id} not found`);
  }
}

/** Travellers named on a booking or ticket must be on the trip. */
async function assertOnTrip(tripId: number, travellerIds: number[]): Promise<void> {
  const onTrip = new Set(await tripTravellerIds(tripId));
  if (travellerIds.some((id) => !onTrip.has(id))) {
    throw new HttpError(400, 'Only travellers on this trip can be added. Add them to the trip first.');
  }
}

const logTrip = (req: Request, tripId: number, action: string, details?: string) =>
  audit(currentUser(req), action, 'trip', tripId, details);

// ---------------------------------------------------------------- trips

tripsRouter.get('/', async (req, res) => {
  const query = pagingSchema
    .merge(sortSchema)
    .extend({
      q: z.string().max(200).optional().default(''),
      filter: z.enum(TRIP_FILTERS).default('all'),
      companyId: optId,
      travellerId: optId,
    })
    .parse(req.query);
  const { rows, total } = await searchTrips({
    q: query.q,
    filter: query.filter,
    companyId: query.companyId,
    travellerId: query.travellerId,
    sort: query.sort ?? null,
    dir: query.dir,
    today: today(),
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  res.json({ trips: rows, total, page: query.page, pageSize: query.pageSize });
});

tripsRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const input = tripSchema.parse(req.body);
  await assertLinks(input);
  const id = await createTrip(input, user.id);
  const trip = (await getTrip(id, today()))!;
  await audit(user, 'trip_created', 'trip', id, `${trip.reference} ${trip.name}`);
  res.status(201).json({ trip });
});

tripsRouter.get('/:id', async (req, res) => {
  const { id } = await requireTrip(req.params.id);
  await audit(currentUser(req), 'trip_viewed', 'trip', id);
  res.json(await getTripDetail(id, today()));
});

tripsRouter.put('/:id', async (req, res) => {
  const { id } = await requireTrip(req.params.id);
  const input = tripSchema.parse(req.body);
  await assertLinks(input);
  await updateTrip(id, input);
  await logTrip(req, id, 'trip_updated');
  res.json({ trip: await getTrip(id, today()) });
});

/** Moves the trip to the trash; it disappears from company and traveller views until restored. */
tripsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const trip = await requireTrip(req.params.id);
  await moveToTrash('trip', trip.id);
  await logTrip(req, trip.id, 'trip_trashed', `${trip.reference} ${trip.name}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- flight tickets

tripsRouter.post('/:id/flights/:flightId/tickets', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const flightId = parseId(req.params.flightId);
  if (!(await getBooking('flights', tripId, flightId))) throw new HttpError(404, 'Flight not found');
  const input = ticketSchema.parse(req.body);
  await assertOnTrip(tripId, [input.client_id]);
  if (await hasTicket(flightId, input.client_id)) {
    throw new HttpError(409, 'This traveller already has a ticket for this flight');
  }
  const id = await createTicket(tripId, flightId, input);
  await logTrip(req, tripId, 'trip_ticket_added', `${input.ticket_number ?? 'ticket'} (${input.status})`);
  res.status(201).json({ ticket: await getTicket(tripId, id) });
});

tripsRouter.put('/:id/tickets/:ticketId', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const ticket = await getTicket(tripId, parseId(req.params.ticketId));
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  const input = ticketSchema.parse(req.body);
  await assertOnTrip(tripId, [input.client_id]);
  await updateTicket(tripId, ticket.id, input);
  await logTrip(req, tripId, 'trip_ticket_updated', `${input.ticket_number ?? `#${ticket.id}`} (${input.status})`);
  res.json({ ticket: await getTicket(tripId, ticket.id) });
});

tripsRouter.post('/:id/tickets/:ticketId/resolve', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const ticket = await getTicket(tripId, parseId(req.params.ticketId));
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  if (ticket.status !== 'open') throw new HttpError(400, 'Only open tickets can be resolved');
  const { resolution, notes } = resolutionSchema.parse(req.body);
  await resolveTicket(tripId, ticket.id, resolution, notes, currentUser(req).id);
  await logTrip(req, tripId, 'trip_ticket_resolved', `${ticket.ticket_number ?? `#${ticket.id}`}: ${resolution}`);
  res.json({ ticket: await getTicket(tripId, ticket.id) });
});

tripsRouter.delete('/:id/tickets/:ticketId', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const ticket = await getTicket(tripId, parseId(req.params.ticketId));
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  await deleteTicket(tripId, ticket.id);
  await logTrip(req, tripId, 'trip_ticket_removed', ticket.ticket_number ?? `#${ticket.id}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- trip documents

tripsRouter.post('/:id/documents', upload.single('file'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const { title } = z.object({ title: z.string().trim().max(200).optional().default('') }).parse(req.body);
  const file = await storeUpload(req.file);
  if (!file) throw new HttpError(400, 'Choose a file to upload');
  try {
    const id = await createTripDocument(tripId, title || file.original_name, file, currentUser(req).id);
    await logTrip(req, tripId, 'trip_document_added', title || file.original_name);
    res.status(201).json({ document: { id } });
  } catch (err) {
    await removeFile(file.file_name);
    throw err;
  }
});

tripsRouter.get('/:id/documents/:docId/file', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const doc = await getTripDocument(tripId, parseId(req.params.docId));
  if (!doc) throw new HttpError(404, 'Document not found');
  const download = req.query.download === '1';
  await audit(currentUser(req), download ? 'file_downloaded' : 'file_viewed', 'trip_document', doc.id);
  const body = await readFile(doc.file_name);
  res.set({
    'Content-Type': doc.mime_type ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', doc.original_name || `trip-document-${doc.id}`),
    'Cache-Control': 'private, no-store',
  });
  res.send(body);
});

tripsRouter.delete('/:id/documents/:docId', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const doc = await getTripDocument(tripId, parseId(req.params.docId));
  if (!doc) throw new HttpError(404, 'Document not found');
  await deleteTripDocument(tripId, doc.id);
  await removeFile(doc.file_name);
  await logTrip(req, tripId, 'trip_document_removed', doc.title);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- bookings
// Registered last so the fixed /tickets and /documents paths above match first.

function parseKind(raw: unknown): BookingKind {
  if (!BOOKING_KINDS.includes(raw as BookingKind)) throw new HttpError(404, 'Not found');
  return raw as BookingKind;
}

const singular = (kind: BookingKind) => kind.slice(0, -1);

async function parseBooking(kind: BookingKind, tripId: number, body: unknown) {
  const data = bookingSchemas[kind].parse(body) as Record<string, unknown>;
  const travellerIds = idList.parse((body as { traveller_ids?: unknown })?.traveller_ids ?? []);
  await assertOnTrip(tripId, travellerIds);
  return { data, travellerIds };
}

tripsRouter.post('/:id/:kind', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const kind = parseKind(req.params.kind);
  const { data, travellerIds } = await parseBooking(kind, tripId, req.body);
  const id = await createBooking(kind, tripId, data, travellerIds);
  await logTrip(req, tripId, `trip_${singular(kind)}_added`, `#${id}`);
  res.status(201).json({ booking: await getBooking(kind, tripId, id) });
});

tripsRouter.put('/:id/:kind/:bookingId', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const kind = parseKind(req.params.kind);
  const bookingId = parseId(req.params.bookingId);
  if (!(await getBooking(kind, tripId, bookingId))) throw new HttpError(404, 'Booking not found');
  const { data, travellerIds } = await parseBooking(kind, tripId, req.body);
  await updateBooking(kind, tripId, bookingId, data, travellerIds);
  await logTrip(req, tripId, `trip_${singular(kind)}_updated`, `#${bookingId}`);
  res.json({ booking: await getBooking(kind, tripId, bookingId) });
});

tripsRouter.delete('/:id/:kind/:bookingId', async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const kind = parseKind(req.params.kind);
  const bookingId = parseId(req.params.bookingId);
  if (!(await getBooking(kind, tripId, bookingId))) throw new HttpError(404, 'Booking not found');
  await deleteBooking(kind, tripId, bookingId);
  await logTrip(req, tripId, `trip_${singular(kind)}_removed`, `#${bookingId}`);
  res.json({ ok: true });
});
