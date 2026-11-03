import { Router, type Request } from 'express';
import { z } from 'zod';
import { audit, getClient, moveToTrash, timezone } from '../db/repo.js';
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
  itineraryFor,
  hasTicket,
  resolveTicket,
  searchTrips,
  TRIP_FILTERS,
  tripTravellerIds,
  updateBooking,
  updateTicket,
  updateTrip,
  type BookingKind,
  type TripInput,
} from '../db/trips.js';
import { currentUser } from '../auth/session.js';
import { todayInTz } from '../lib/dates.js';
import { readFile, removeFile } from '../lib/files.js';
import { contentDisposition, HttpError, parseId } from '../lib/http.js';
import { bookingSchemas, idList, optId, pagingSchema, resolutionSchema, sortSchema, ticketSchema, tripSchema } from './schemas.js';
import { storeUpload, upload } from './uploads.js';
import { getTripQc, QC_ANSWERS, resetQc, saveTripQc } from '../db/quality.js';
import { EXPORT_LIMIT, exportFileName, sendWorkbook } from '../lib/excel.js';
import { requirePermission } from '../auth/permissions.js';

/** Trips and everything booked on them. Companies and travellers link to these same records. */
export const tripsRouter = Router();

const today = () => todayInTz(timezone());

async function requireTrip(rawId: unknown) {
  const trip = await getTrip(parseId(rawId), today());
  if (!trip) throw new HttpError(404, 'Trip not found');
  return trip;
}

async function assertLinks(input: TripInput): Promise<void> {
  if (input.company_id !== null && !(await getCompany(input.company_id))) {
    throw new HttpError(400, 'company_id: company not found');
  }
  for (const id of input.traveller_ids) {
    if (!(await getClient(id))) throw new HttpError(400, `traveller_ids: traveller #${id} not found`);
  }
  const onTrip = new Set(input.traveller_ids);
  for (const item of input.itinerary) {
    if (item.open_credit?.traveller_ids.some((id) => !onTrip.has(id))) {
      throw new HttpError(400, 'Open credit can only be given to travellers on this trip.');
    }
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

/** A change to the trip or its bookings means its quality check has to be done again. */
async function qcChanged(req: Request, tripId: number): Promise<void> {
  if (await resetQc(tripId)) await logTrip(req, tripId, 'trip_qc_reset', 'trip changed after the quality check');
}

/** Notes in the trip's history which rows were moved to Open Credits. */
async function logCredits(req: Request, tripId: number, input: TripInput): Promise<void> {
  for (const i of input.itinerary) {
    const n = i.open_credit?.traveller_ids.length;
    if (!n) continue;
    const what = [i.airline, i.flight_number].filter(Boolean).join(' ') || i.type;
    await logTrip(req, tripId, 'trip_open_credit_added', `${what} ${[i.origin, i.destination].filter(Boolean).join(' → ')} ${i.departure_date} for ${n} traveller(s)`);
  }
}

// ---------------------------------------------------------------- trips

/** The Trips list's filters; the Excel export uses the same ones. */
const listSchema = pagingSchema.merge(sortSchema).extend({
  q: z.string().max(200).optional().default(''),
  filter: z.enum(TRIP_FILTERS).default('all'),
  companyId: optId,
  travellerId: optId,
});

const searchFrom = (query: z.infer<typeof listSchema>, limit: number, offset: number) =>
  searchTrips({
    q: query.q,
    filter: query.filter,
    companyId: query.companyId,
    travellerId: query.travellerId,
    sort: query.sort ?? null,
    dir: query.dir,
    today: today(),
    limit,
    offset,
  });

tripsRouter.get('/', requirePermission('trips', 'view'), async (req, res) => {
  const query = listSchema.parse(req.query);
  const { rows, total } = await searchFrom(query, query.pageSize, (query.page - 1) * query.pageSize);
  res.json({ trips: rows, total, page: query.page, pageSize: query.pageSize });
});

/** The filtered list as an Excel file: one sheet of trips, one of their itinerary items. */
tripsRouter.get('/export', requirePermission('trips', 'export'), async (req, res) => {
  const query = listSchema.parse(req.query);
  const { rows } = await searchFrom(query, EXPORT_LIMIT, 0);
  const byId = new Map(rows.map((t) => [t.id, t]));
  const itinerary = await itineraryFor(rows.map((t) => t.id));
  const search = query.q ? `, search "${query.q}"` : '';
  await audit(currentUser(req), 'trips_exported', 'trip', null, `${rows.length} trip(s); filter ${query.filter}${search}`);
  await sendWorkbook(res, exportFileName('trips', today()), [
    {
      name: 'Trips',
      columns: [
        { header: 'Reference', key: 'reference', width: 16 },
        { header: 'Trip name', key: 'name', width: 30 },
        { header: 'Company', key: 'company_name', width: 24 },
        { header: 'Travellers', key: 'traveller_names', width: 36 },
        { header: 'Origin', key: 'origin' },
        { header: 'Destinations', key: 'destinations', width: 28 },
        { header: 'Departure', key: 'departure_date' },
        { header: 'Return/End', key: 'return_date' },
        { header: 'Type', key: 'trip_type' },
        { header: 'Trip status', key: 'status', width: 14 },
        { header: 'Phase', key: 'phase' },
        { header: 'Open tickets', key: 'open_tickets' },
        { header: 'Notes', key: 'notes', width: 30 },
        { header: 'Last updated', key: 'updated_at', width: 22 },
      ],
      rows,
    },
    {
      name: 'Itinerary',
      columns: [
        { header: 'Trip reference', key: 'reference', width: 16 },
        { header: 'Trip name', key: 'trip_name', width: 30 },
        { header: 'Type', key: 'type' },
        { header: 'Airline/Operator', key: 'airline', width: 18 },
        { header: 'Flight/Train No.', key: 'flight_number', width: 16 },
        { header: 'Hotel/Company/Description', key: 'name', width: 28 },
        { header: 'Origin/Pick-up', key: 'origin', width: 18 },
        { header: 'Destination/City/Location', key: 'destination', width: 18 },
        { header: 'Start date', key: 'departure_date', width: 15 },
        { header: 'Start time', key: 'departure_time', width: 15 },
        { header: 'End date', key: 'arrival_date', width: 15 },
        { header: 'End time', key: 'arrival_time', width: 15 },
        { header: 'A/L PNR/Conf. No.', key: 'confirmation_number', width: 18 },
        { header: 'GDS PNR/TKT No.', key: 'gds_pnr', width: 18 },
      ],
      rows: itinerary.map((i) => ({ ...i, reference: byId.get(i.trip_id)?.reference, trip_name: byId.get(i.trip_id)?.name })),
    },
  ]);
});

tripsRouter.post('/', requirePermission('trips', 'add'), async (req, res) => {
  const user = currentUser(req);
  const input = tripSchema.parse(req.body);
  if (!input.itinerary.length) throw new HttpError(400, 'itinerary: add at least one flight, train, hotel, car or other item with its date');
  await assertLinks(input);
  const id = await createTrip(input, user.id);
  const trip = (await getTrip(id, today()))!;
  await audit(user, 'trip_created', 'trip', id, `${trip.reference} ${trip.name}`);
  await logCredits(req, id, input);
  res.status(201).json({ trip });
});

tripsRouter.get('/:id', requirePermission('trips', 'view'), async (req, res) => {
  const { id } = await requireTrip(req.params.id);
  await audit(currentUser(req), 'trip_viewed', 'trip', id);
  res.json({ ...(await getTripDetail(id, today())), qc: await getTripQc(id, today()) });
});

tripsRouter.put('/:id', requirePermission('trips', 'edit'), async (req, res) => {
  const { id } = await requireTrip(req.params.id);
  const input = tripSchema.parse(req.body);
  await assertLinks(input);
  await updateTrip(id, input, currentUser(req).id);
  await logTrip(req, id, 'trip_updated');
  await qcChanged(req, id);
  await logCredits(req, id, input);
  res.json({ trip: await getTrip(id, today()) });
});

/** Moves the trip to the trash; it disappears from company and traveller views until restored. */
tripsRouter.delete('/:id', requirePermission('trips', 'delete'), async (req, res) => {
  const trip = await requireTrip(req.params.id);
  await moveToTrash('trip', trip.id);
  await logTrip(req, trip.id, 'trip_trashed', `${trip.reference} ${trip.name}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- flight tickets

tripsRouter.post('/:id/flights/:flightId/tickets', requirePermission('trips', 'edit'), async (req, res) => {
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
  await qcChanged(req, tripId);
  res.status(201).json({ ticket: await getTicket(tripId, id) });
});

tripsRouter.put('/:id/tickets/:ticketId', requirePermission('trips', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const ticket = await getTicket(tripId, parseId(req.params.ticketId));
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  const input = ticketSchema.parse(req.body);
  await assertOnTrip(tripId, [input.client_id]);
  await updateTicket(tripId, ticket.id, input);
  await logTrip(req, tripId, 'trip_ticket_updated', `${input.ticket_number ?? `#${ticket.id}`} (${input.status})`);
  await qcChanged(req, tripId);
  res.json({ ticket: await getTicket(tripId, ticket.id) });
});

tripsRouter.post('/:id/tickets/:ticketId/resolve', requirePermission('trips', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const ticket = await getTicket(tripId, parseId(req.params.ticketId));
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  if (ticket.status !== 'open') throw new HttpError(400, 'Only open tickets can be resolved');
  const { resolution, notes } = resolutionSchema.parse(req.body);
  await resolveTicket(tripId, ticket.id, resolution, notes, currentUser(req).id);
  await logTrip(req, tripId, 'trip_ticket_resolved', `${ticket.ticket_number ?? `#${ticket.id}`}: ${resolution}`);
  await qcChanged(req, tripId);
  res.json({ ticket: await getTicket(tripId, ticket.id) });
});

tripsRouter.delete('/:id/tickets/:ticketId', requirePermission('trips', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const ticket = await getTicket(tripId, parseId(req.params.ticketId));
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  await deleteTicket(tripId, ticket.id);
  await logTrip(req, tripId, 'trip_ticket_removed', ticket.ticket_number ?? `#${ticket.id}`);
  await qcChanged(req, tripId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- trip documents

tripsRouter.post('/:id/documents', requirePermission('trips', 'edit'), upload.single('file'), async (req, res) => {
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

tripsRouter.get('/:id/documents/:docId/file', requirePermission('trips', 'view'), async (req, res) => {
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

tripsRouter.delete('/:id/documents/:docId', requirePermission('trips', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const doc = await getTripDocument(tripId, parseId(req.params.docId));
  if (!doc) throw new HttpError(404, 'Document not found');
  await deleteTripDocument(tripId, doc.id);
  await removeFile(doc.file_name);
  await logTrip(req, tripId, 'trip_document_removed', doc.title);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- quality check

const qcSchema = z.object({
  answers: z
    .array(z.object({ item_id: z.coerce.number().int().positive(), answer: z.enum(QC_ANSWERS).nullable() }))
    .max(200),
});

tripsRouter.put('/:id/qc', requirePermission('quality', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const { answers } = qcSchema.parse(req.body);
  const { passed, newlyPassed } = await saveTripQc(tripId, answers, currentUser(req).id);
  const answered = answers.filter((a) => a.answer).length;
  await logTrip(req, tripId, newlyPassed ? 'trip_qc_passed' : 'trip_qc_updated', `${answered} item(s) answered${passed ? '; quality check passed' : ''}`);
  res.json({ qc: await getTripQc(tripId, today()) });
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

tripsRouter.post('/:id/:kind', requirePermission('trips', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const kind = parseKind(req.params.kind);
  const { data, travellerIds } = await parseBooking(kind, tripId, req.body);
  const id = await createBooking(kind, tripId, data, travellerIds);
  await logTrip(req, tripId, `trip_${singular(kind)}_added`, `#${id}`);
  await qcChanged(req, tripId);
  res.status(201).json({ booking: await getBooking(kind, tripId, id) });
});

tripsRouter.put('/:id/:kind/:bookingId', requirePermission('trips', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const kind = parseKind(req.params.kind);
  const bookingId = parseId(req.params.bookingId);
  if (!(await getBooking(kind, tripId, bookingId))) throw new HttpError(404, 'Booking not found');
  const { data, travellerIds } = await parseBooking(kind, tripId, req.body);
  await updateBooking(kind, tripId, bookingId, data, travellerIds);
  await logTrip(req, tripId, `trip_${singular(kind)}_updated`, `#${bookingId}`);
  await qcChanged(req, tripId);
  res.json({ booking: await getBooking(kind, tripId, bookingId) });
});

tripsRouter.delete('/:id/:kind/:bookingId', requirePermission('trips', 'edit'), async (req, res) => {
  const { id: tripId } = await requireTrip(req.params.id);
  const kind = parseKind(req.params.kind);
  const bookingId = parseId(req.params.bookingId);
  if (!(await getBooking(kind, tripId, bookingId))) throw new HttpError(404, 'Booking not found');
  await deleteBooking(kind, tripId, bookingId);
  await logTrip(req, tripId, `trip_${singular(kind)}_removed`, `#${bookingId}`);
  await qcChanged(req, tripId);
  res.json({ ok: true });
});
