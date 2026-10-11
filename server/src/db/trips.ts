import crypto from 'node:crypto';
import { column, insert, one, query, run, tx, value } from './index.js';
import { likePattern, orderBy, updateRow, type Bindable, type SortDir, type StoredFile } from './repo.js';

// ---------------------------------------------------------------- trips

export const TRIP_TYPES = ['business', 'leisure', 'group', 'event', 'other'] as const;
export const TRIP_STATUSES = ['planned', 'confirmed', 'cancelled'] as const;
/** Upcoming / ongoing / past come from the dates; cancelled from the status. */
export const TRIP_FILTERS = ['all', 'upcoming', 'ongoing', 'past', 'cancelled', 'open_tickets'] as const;
export type TripFilter = (typeof TRIP_FILTERS)[number];

export interface DestinationInput {
  city: string;
  country: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  notes: string | null;
}

export interface TripFields {
  name: string;
  company_id: number | null;
  origin: string | null;
  departure_date: string;
  return_date: string | null;
  trip_type: (typeof TRIP_TYPES)[number];
  status: (typeof TRIP_STATUSES)[number];
  notes: string | null;
}

export interface TripInput extends TripFields {
  traveller_ids: number[];
  destinations: DestinationInput[];
}

export interface TripRow extends TripFields {
  id: number;
  reference: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TripWithCompany extends TripRow {
  company_name: string | null;
  phase: 'upcoming' | 'ongoing' | 'past' | 'cancelled';
}

const TRIP_FIELDS = ['name', 'company_id', 'origin', 'departure_date', 'return_date', 'trip_type', 'status', 'notes'] as const;

/** Needs the @today parameter. */
const PHASE_SQL = `CASE
  WHEN t.status = 'cancelled' THEN 'cancelled'
  WHEN t.departure_date > @today THEN 'upcoming'
  WHEN COALESCE(t.return_date, t.departure_date) >= @today THEN 'ongoing'
  ELSE 'past' END`;

/** People join tables for bookings; someone taken off the trip also comes off these. */
const PEOPLE_TABLES = [
  { table: 'trip_flight_tickets', fk: 'flight_id', parent: 'trip_flights' },
  { table: 'trip_hotel_guests', fk: 'hotel_id', parent: 'trip_hotels' },
  { table: 'trip_car_passengers', fk: 'car_id', parent: 'trip_cars' },
  { table: 'trip_cruise_passengers', fk: 'cruise_id', parent: 'trip_cruises' },
];

async function replaceTravellers(tripId: number, travellerIds: number[]): Promise<void> {
  const keep = new Set(travellerIds);
  const current = await column<number>('SELECT client_id FROM trip_travellers WHERE trip_id = ?', [tripId]);
  for (const clientId of current) {
    if (keep.has(clientId)) continue;
    await run('DELETE FROM trip_travellers WHERE trip_id = ? AND client_id = ?', [tripId, clientId]);
    for (const p of PEOPLE_TABLES) {
      await run(`DELETE FROM ${p.table} WHERE client_id = ? AND ${p.fk} IN (SELECT id FROM ${p.parent} WHERE trip_id = ?)`, [
        clientId,
        tripId,
      ]);
    }
  }
  for (const clientId of keep) {
    await run('INSERT INTO trip_travellers (trip_id, client_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [tripId, clientId]);
  }
}

async function replaceDestinations(tripId: number, destinations: DestinationInput[]): Promise<void> {
  await run('DELETE FROM trip_segments WHERE trip_id = ?', [tripId]);
  for (const [position, d] of destinations.entries()) {
    await run(
      `INSERT INTO trip_segments (trip_id, position, city, country, arrival_date, departure_date, notes)
       VALUES (@trip_id, @position, @city, @country, @arrival_date, @departure_date, @notes)`,
      { trip_id: tripId, position, ...d },
    );
  }
}

export function createTrip(input: TripInput, userId: number): Promise<number> {
  return tx(async () => {
    const { traveller_ids, destinations, ...fields } = input;
    const id = await insert(
      `INSERT INTO trips (reference, ${TRIP_FIELDS.join(', ')}, created_by)
       VALUES (@reference, ${TRIP_FIELDS.map((f) => '@' + f).join(', ')}, @created_by)`,
      { ...fields, reference: `pending-${crypto.randomUUID()}`, created_by: userId },
    );
    await run(`UPDATE trips SET reference = 'TRP-' || to_char(created_at, 'YYYY') || '-' || lpad(id::text, 5, '0') WHERE id = ?`, [id]);
    await replaceTravellers(id, traveller_ids);
    await replaceDestinations(id, destinations);
    return id;
  });
}

export function updateTrip(id: number, input: TripInput): Promise<void> {
  return tx(async () => {
    const { traveller_ids, destinations, ...fields } = input;
    await updateRow('trips', id, { ...fields }, TRIP_FIELDS);
    await replaceTravellers(id, traveller_ids);
    await replaceDestinations(id, destinations);
    await touchTrip(id);
  });
}

/** Marks the trip as changed when one of its bookings changes. */
export async function touchTrip(id: number): Promise<void> {
  await run('UPDATE trips SET updated_at = now() WHERE id = ?', [id]);
}

/** Trashed trips are hidden unless `includeDeleted` is set. */
export function getTrip(id: number, today: string, includeDeleted = false): Promise<TripWithCompany | undefined> {
  return one<TripWithCompany>(
    `SELECT t.*, co.name AS company_name, ${PHASE_SQL} AS phase
     FROM trips t LEFT JOIN companies co ON co.id = t.company_id
     WHERE t.id = @id AND (t.deleted_at IS NULL OR @includeDeleted::boolean)`,
    { id, today, includeDeleted },
  );
}

/** Permanently deletes the trip and all its bookings; returns stored file names to remove from storage. */
export function purgeTrip(id: number): Promise<string[]> {
  return tx(async () => {
    const files = await column<string>('SELECT file_name FROM trip_documents WHERE trip_id = ?', [id]);
    await run('DELETE FROM trips WHERE id = ?', [id]);
    return files;
  });
}

export function tripTravellerIds(tripId: number): Promise<number[]> {
  return column<number>(
    `SELECT tt.client_id FROM trip_travellers tt JOIN clients c ON c.id = tt.client_id
     WHERE tt.trip_id = ? AND c.deleted_at IS NULL`,
    [tripId],
  );
}

export interface TripSearch {
  q: string;
  filter: TripFilter;
  companyId: number | null;
  travellerId: number | null;
  sort: string | null;
  dir: SortDir;
  today: string;
  limit: number;
  offset: number;
}

export interface TripListRow extends TripWithCompany {
  destinations: string | null;
  traveller_names: string | null;
  traveller_count: number;
  open_tickets: number;
}

const TRIP_SORTS: Record<string, string> = {
  reference: 'reference {dir}',
  name: 'lower(name) {dir}, id',
  company: 'company_name IS NULL, lower(company_name) {dir}, departure_date',
  origin: 'origin IS NULL, lower(origin) {dir}, id',
  departure: 'departure_date {dir}, id {dir}',
  return: 'COALESCE(return_date, departure_date) {dir}, id {dir}',
  type: 'trip_type {dir}, departure_date',
  status: 'phase {dir}, departure_date',
  updated: 'updated_at {dir}, id {dir}',
};

const OPEN_TICKETS = `(SELECT COUNT(*) FROM trip_flight_tickets k JOIN trip_flights f ON f.id = k.flight_id
  WHERE f.trip_id = t.id AND k.status = 'open')`;

const TRAVELLERS_OF_TRIP = `FROM trip_travellers tt JOIN clients c ON c.id = tt.client_id
  WHERE tt.trip_id = t.id AND c.deleted_at IS NULL`;

export async function searchTrips(s: TripSearch): Promise<{ rows: TripListRow[]; total: number }> {
  const where: string[] = ['t.deleted_at IS NULL'];
  const params: Record<string, Bindable> = {};

  if (s.filter === 'open_tickets') {
    where.push(`${OPEN_TICKETS} > 0`);
  } else if (s.filter !== 'all') {
    where.push(`(${PHASE_SQL}) = @phase`);
    params.phase = s.filter;
    params.today = s.today;
  }
  if (s.companyId) {
    where.push('t.company_id = @companyId');
    params.companyId = s.companyId;
  }
  if (s.travellerId) {
    where.push('EXISTS (SELECT 1 FROM trip_travellers tt WHERE tt.trip_id = t.id AND tt.client_id = @travellerId)');
    params.travellerId = s.travellerId;
  }
  // Every word has to match somewhere: the trip, its company, a destination or a traveller.
  s.q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .forEach((word, i) => {
      const p = `@q${i}`;
      params[`q${i}`] = likePattern(word);
      const like = (col: string) => `${col} ILIKE ${p} ESCAPE '\\'`;
      where.push(`(
        ${['t.reference', 't.name', 't.origin', 't.notes'].map(like).join(' OR ')}
        OR EXISTS (SELECT 1 FROM companies co2 WHERE co2.id = t.company_id AND ${like('co2.name')})
        OR EXISTS (SELECT 1 FROM trip_segments sg WHERE sg.trip_id = t.id AND (${like('sg.city')} OR ${like('sg.country')}))
        OR EXISTS (SELECT 1 ${TRAVELLERS_OF_TRIP} AND (${like('c.first_name')} OR ${like('c.last_name')}))
      )`);
    });
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await query<TripListRow>(
    `SELECT * FROM (
       SELECT t.*, co.name AS company_name, ${PHASE_SQL} AS phase,
         (SELECT string_agg(sg.city, ', ' ORDER BY sg.position) FROM trip_segments sg WHERE sg.trip_id = t.id) AS destinations,
         (SELECT string_agg(c.first_name || ' ' || c.last_name, ', ' ORDER BY lower(c.last_name)) ${TRAVELLERS_OF_TRIP}) AS traveller_names,
         (SELECT COUNT(*) ${TRAVELLERS_OF_TRIP}) AS traveller_count,
         ${OPEN_TICKETS} AS open_tickets
       FROM trips t LEFT JOIN companies co ON co.id = t.company_id
       ${whereSql}
     ) s
     ORDER BY ${orderBy(TRIP_SORTS, s.sort, s.dir, 'departure')}
     LIMIT @limit OFFSET @offset`,
    { ...params, today: s.today, limit: s.limit, offset: s.offset },
  );
  const total = await value<number>(`SELECT COUNT(*) FROM trips t ${whereSql}`, params);
  return { rows, total };
}

export function countUpcomingTrips(today: string): Promise<number> {
  return value<number>(
    `SELECT COUNT(*) FROM trips WHERE deleted_at IS NULL AND status != 'cancelled' AND departure_date > ?`,
    [today],
  );
}

// ---------------------------------------------------------------- bookings (flights, hotels, cars, cruises)

/**
 * Each booking kind has its own table. Column names come from this whitelist
 * only; `people` is the join table of travellers on that booking, if any.
 */
export const BOOKINGS = {
  flights: {
    table: 'trip_flights',
    fields: ['airline', 'flight_number', 'from_airport', 'to_airport', 'departs_at', 'arrives_at', 'cabin_class', 'booking_reference', 'notes'],
    order: 'departs_at IS NULL, departs_at, id',
    people: null,
  },
  hotels: {
    table: 'trip_hotels',
    fields: ['name', 'city', 'address', 'check_in', 'check_out', 'room_type', 'confirmation_number', 'notes'],
    order: 'check_in IS NULL, check_in, id',
    people: { table: 'trip_hotel_guests', fk: 'hotel_id' },
  },
  cars: {
    table: 'trip_cars',
    fields: ['provider', 'car_type', 'pickup_location', 'pickup_at', 'dropoff_location', 'dropoff_at', 'confirmation_number', 'notes'],
    order: 'pickup_at IS NULL, pickup_at, id',
    people: { table: 'trip_car_passengers', fk: 'car_id' },
  },
  cruises: {
    table: 'trip_cruises',
    fields: ['cruise_line', 'ship', 'embark_port', 'embark_date', 'disembark_port', 'disembark_date', 'cabin', 'confirmation_number', 'notes'],
    order: 'embark_date IS NULL, embark_date, id',
    people: { table: 'trip_cruise_passengers', fk: 'cruise_id' },
  },
} as const;
export type BookingKind = keyof typeof BOOKINGS;
export const BOOKING_KINDS = Object.keys(BOOKINGS) as BookingKind[];

type BookingRow = Record<string, unknown> & { id: number; trip_id: number };

async function setPeople(kind: BookingKind, bookingId: number, travellerIds: number[]): Promise<void> {
  const people = BOOKINGS[kind].people;
  if (!people) return;
  await run(`DELETE FROM ${people.table} WHERE ${people.fk} = ?`, [bookingId]);
  for (const id of travellerIds) {
    await run(`INSERT INTO ${people.table} (${people.fk}, client_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, [bookingId, id]);
  }
}

export function getBooking(kind: BookingKind, tripId: number, id: number): Promise<BookingRow | undefined> {
  return one<BookingRow>(`SELECT * FROM ${BOOKINGS[kind].table} WHERE id = ? AND trip_id = ?`, [id, tripId]);
}

export function createBooking(kind: BookingKind, tripId: number, data: Record<string, unknown>, travellerIds: number[]): Promise<number> {
  const { table, fields } = BOOKINGS[kind];
  return tx(async () => {
    const id = await insert(
      `INSERT INTO ${table} (trip_id, ${fields.join(', ')}) VALUES (@trip_id, ${fields.map((f) => '@' + f).join(', ')})`,
      { ...Object.fromEntries(fields.map((f) => [f, (data[f] as Bindable) ?? null])), trip_id: tripId },
    );
    await setPeople(kind, id, travellerIds);
    await touchTrip(tripId);
    return id;
  });
}

export function updateBooking(kind: BookingKind, tripId: number, id: number, data: Record<string, unknown>, travellerIds: number[]): Promise<void> {
  const { table, fields } = BOOKINGS[kind];
  return tx(async () => {
    await updateRow(table, id, data, fields);
    await setPeople(kind, id, travellerIds);
    await touchTrip(tripId);
  });
}

export function deleteBooking(kind: BookingKind, tripId: number, id: number): Promise<void> {
  return tx(async () => {
    await run(`DELETE FROM ${BOOKINGS[kind].table} WHERE id = ? AND trip_id = ?`, [id, tripId]);
    await touchTrip(tripId);
  });
}

async function listBookings(kind: BookingKind, tripId: number): Promise<(BookingRow & { traveller_ids?: number[] })[]> {
  const { table, order, people } = BOOKINGS[kind];
  const rows = await query<BookingRow>(`SELECT * FROM ${table} WHERE trip_id = ? ORDER BY ${order}`, [tripId]);
  if (!people) return rows;
  const links = await query<{ booking_id: number; client_id: number }>(
    `SELECT p.${people.fk} AS booking_id, p.client_id FROM ${people.table} p
     JOIN ${table} b ON b.id = p.${people.fk} WHERE b.trip_id = ?`,
    [tripId],
  );
  return rows.map((r) => ({ ...r, traveller_ids: links.filter((l) => l.booking_id === r.id).map((l) => l.client_id) }));
}

// ---------------------------------------------------------------- flight tickets

export const TICKET_STATUSES = ['issued', 'open', 'used', 'refunded', 'exchanged', 'void'] as const;
export const TICKET_RESOLUTIONS = ['used', 'refunded', 'exchanged', 'void'] as const;

export interface TicketInput {
  client_id: number;
  ticket_number: string | null;
  status: (typeof TICKET_STATUSES)[number];
  notes: string | null;
}

export interface TicketRow extends TicketInput {
  id: number;
  flight_id: number;
  created_at: string;
  updated_at: string;
}

/** The ticket, only if it belongs to a flight on this trip. */
export function getTicket(tripId: number, ticketId: number): Promise<TicketRow | undefined> {
  return one<TicketRow>(
    `SELECT k.* FROM trip_flight_tickets k JOIN trip_flights f ON f.id = k.flight_id
     WHERE k.id = ? AND f.trip_id = ?`,
    [ticketId, tripId],
  );
}

export async function hasTicket(flightId: number, clientId: number): Promise<boolean> {
  return Boolean(await one('SELECT 1 FROM trip_flight_tickets WHERE flight_id = ? AND client_id = ?', [flightId, clientId]));
}

export function createTicket(tripId: number, flightId: number, input: TicketInput): Promise<number> {
  return tx(async () => {
    const id = await insert(
      `INSERT INTO trip_flight_tickets (flight_id, client_id, ticket_number, status, notes)
       VALUES (@flight_id, @client_id, @ticket_number, @status, @notes)`,
      { flight_id: flightId, ...input },
    );
    await touchTrip(tripId);
    return id;
  });
}

export function updateTicket(tripId: number, ticketId: number, input: TicketInput): Promise<void> {
  return tx(async () => {
    await updateRow('trip_flight_tickets', ticketId, { ...input }, ['client_id', 'ticket_number', 'status', 'notes']);
    await touchTrip(tripId);
  });
}

export function deleteTicket(tripId: number, ticketId: number): Promise<void> {
  return tx(async () => {
    await run('DELETE FROM trip_flight_tickets WHERE id = ?', [ticketId]);
    await touchTrip(tripId);
  });
}

/** Records how an open ticket was settled and sets the ticket's status to match. */
export function resolveTicket(
  tripId: number,
  ticketId: number,
  resolution: (typeof TICKET_RESOLUTIONS)[number],
  notes: string | null,
  userId: number,
): Promise<void> {
  return tx(async () => {
    await run('INSERT INTO trip_ticket_resolutions (ticket_id, resolution, notes, resolved_by) VALUES (?, ?, ?, ?)', [
      ticketId,
      resolution,
      notes,
      userId,
    ]);
    await updateRow('trip_flight_tickets', ticketId, { status: resolution }, ['status']);
    await touchTrip(tripId);
  });
}

// ---------------------------------------------------------------- trip documents

export interface TripDocumentRow extends StoredFile {
  id: number;
  trip_id: number;
  title: string;
  uploaded_by: number | null;
  created_at: string;
}

export function getTripDocument(tripId: number, id: number): Promise<TripDocumentRow | undefined> {
  return one<TripDocumentRow>('SELECT * FROM trip_documents WHERE id = ? AND trip_id = ?', [id, tripId]);
}

export function createTripDocument(tripId: number, title: string, file: StoredFile, userId: number): Promise<number> {
  return tx(async () => {
    const id = await insert(
      `INSERT INTO trip_documents (trip_id, title, file_name, original_name, mime_type, size, uploaded_by)
       VALUES (@trip_id, @title, @file_name, @original_name, @mime_type, @size, @uploaded_by)`,
      { trip_id: tripId, title, ...file, uploaded_by: userId },
    );
    await touchTrip(tripId);
    return id;
  });
}

export function deleteTripDocument(tripId: number, id: number): Promise<void> {
  return tx(async () => {
    await run('DELETE FROM trip_documents WHERE id = ? AND trip_id = ?', [id, tripId]);
    await touchTrip(tripId);
  });
}

// ---------------------------------------------------------------- full trip

export async function getTripDetail(id: number, today: string) {
  const trip = await getTrip(id, today);
  if (!trip) return undefined;

  const travellers = await query(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.nationality, c.company_id, co.name AS company_name,
       (SELECT MAX(d.expiry_date) FROM documents d WHERE d.client_id = c.id AND d.type = 'passport') AS passport_expiry
     FROM trip_travellers tt JOIN clients c ON c.id = tt.client_id
     LEFT JOIN companies co ON co.id = c.company_id
     WHERE tt.trip_id = ? AND c.deleted_at IS NULL
     ORDER BY lower(c.last_name), lower(c.first_name)`,
    [id],
  );

  const destinations = await query('SELECT * FROM trip_segments WHERE trip_id = ? ORDER BY position', [id]);

  const tickets = await query<TicketRow & { first_name: string; last_name: string }>(
    `SELECT k.*, c.first_name, c.last_name FROM trip_flight_tickets k
     JOIN trip_flights f ON f.id = k.flight_id JOIN clients c ON c.id = k.client_id
     WHERE f.trip_id = ? ORDER BY lower(c.last_name)`,
    [id],
  );
  const resolutions = await query<{ ticket_id: number }>(
    `SELECT r.*, u.name AS resolved_by_name FROM trip_ticket_resolutions r
     JOIN trip_flight_tickets k ON k.id = r.ticket_id JOIN trip_flights f ON f.id = k.flight_id
     LEFT JOIN users u ON u.id = r.resolved_by
     WHERE f.trip_id = ? ORDER BY r.id`,
    [id],
  );

  const flights = (await listBookings('flights', id)).map((f) => ({
    ...f,
    tickets: tickets
      .filter((k) => k.flight_id === f.id)
      .map((k) => ({ ...k, resolutions: resolutions.filter((r) => r.ticket_id === k.id) })),
  }));

  const documents = await query(
    `SELECT d.id, d.trip_id, d.title, d.original_name, d.mime_type, d.size, d.created_at, u.name AS uploaded_by_name
     FROM trip_documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.trip_id = ? ORDER BY d.id DESC`,
    [id],
  );

  return {
    trip,
    travellers,
    destinations,
    flights,
    hotels: await listBookings('hotels', id),
    cars: await listBookings('cars', id),
    cruises: await listBookings('cruises', id),
    documents,
  };
}
