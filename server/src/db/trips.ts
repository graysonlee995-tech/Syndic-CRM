import crypto from 'node:crypto';
import { column, insert, one, query, run, tx, value } from './index.js';
import { likePattern, orderBy, timezone, updateRow, type Bindable, type SortDir, type StoredFile } from './repo.js';
import { dateTimeInTz } from '../lib/dates.js';
import { QC_STATUS_SQL } from './quality.js';

// ---------------------------------------------------------------- trips

export const TRIP_TYPES = ['business', 'leisure', 'group', 'event', 'other'] as const;
export const TRIP_STATUSES = ['active', 'inactive', 'cancelled'] as const;
/** Recent / upcoming / past come from the dates and times; inactive and cancelled from the status. */
export const TRIP_FILTERS = ['all', 'recent', 'upcoming', 'past', 'inactive', 'cancelled'] as const;
export type TripFilter = (typeof TRIP_FILTERS)[number];

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

/**
 * The trip form's rows: flights and trains (the itinerary), then hotels, cars
 * and others, each in its own section. All are stored in trip_itinerary.
 */
export const ITINERARY_TYPES = ['flight', 'train', 'hotel', 'car', 'other'] as const;
/** Only these can be turned into open credit (flights and trains in the itinerary, and hotels). */
export const CREDIT_TYPES = ['flight', 'train', 'hotel'] as const;

export interface ItineraryInput {
  type: (typeof ITINERARY_TYPES)[number];
  /** Flight or train: the airline / rail operator and the flight / train number. */
  airline: string | null;
  flight_number: string | null;
  /** Hotel name, car company, or an "other" item's description. */
  name: string | null;
  /** Flight / train from; car pick-up location. */
  origin: string | null;
  /** Flight / train to; hotel city; car drop-off location; other item's location. */
  destination: string | null;
  /** Departure, check-in, pick-up or start date. */
  departure_date: string;
  /** HH:MM, local time at the origin */
  departure_time: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  confirmation_number: string | null;
  /** Flights and trains only. */
  gds_pnr: string | null;
}

/** A row of the form; with open_credit set it leaves the itinerary as open credit for those travellers. */
export interface ItineraryFormItem extends ItineraryInput {
  open_credit?: { traveller_ids: number[] } | null;
}

/** What the trip form sends: the header and all its rows. */
export interface TripInput extends Pick<TripFields, 'name' | 'company_id' | 'trip_type' | 'status' | 'notes'> {
  traveller_ids: number[];
  itinerary: ItineraryFormItem[];
}

const ITINERARY_FIELDS = [
  'type',
  'airline',
  'flight_number',
  'name',
  'origin',
  'destination',
  'departure_date',
  'departure_time',
  'arrival_date',
  'arrival_time',
  'confirmation_number',
  'gds_pnr',
] as const;

/** Columns copied from a trip row into each open credit. */
const CREDIT_FIELDS = ITINERARY_FIELDS;

/**
 * The trip's origin and dates, worked out from its rows: it starts with the
 * earliest departure and ends with the latest arrival (or departure).
 * On the same day, times decide only when both items have one; otherwise the
 * order entered does. The origin comes from the first flight or train, or else
 * the first item that is not a hotel stay.
 */
export function tripDatesFrom(itinerary: ItineraryInput[]): Pick<TripFields, 'origin' | 'departure_date' | 'return_date'> {
  const byDeparture = (a: ItineraryInput, b: ItineraryInput) =>
    a.departure_date.localeCompare(b.departure_date) ||
    (a.departure_time && b.departure_time ? a.departure_time.localeCompare(b.departure_time) : 0);
  const sorted = [...itinerary].sort(byDeparture); // stable: ties keep the entered order
  const start =
    sorted.find((i) => i.type === 'flight' || i.type === 'train') ?? sorted.find((i) => i.type !== 'hotel') ?? sorted[0];
  const departure = sorted[0].departure_date;
  const end = itinerary.map((i) => i.arrival_date ?? i.departure_date).sort().at(-1)!;
  return {
    origin: start.origin,
    departure_date: departure,
    return_date: end > departure ? end : null,
  };
}

/** Rows marked as open credit are filed under Open Credits (one per traveller) instead of the itinerary. */
async function replaceItinerary(tripId: number, itinerary: ItineraryFormItem[], userId: number | null): Promise<void> {
  await run('DELETE FROM trip_itinerary WHERE trip_id = ?', [tripId]);
  let position = 0;
  for (const { open_credit, ...item } of itinerary) {
    const fields = Object.fromEntries(ITINERARY_FIELDS.map((f) => [f, item[f] ?? null])) as Record<string, Bindable>;
    if (open_credit?.traveller_ids.length && (CREDIT_TYPES as readonly string[]).includes(item.type)) {
      // One credit per traveller; row_key ties them together so the row can be moved back.
      const rowKey = crypto.randomUUID();
      for (const clientId of open_credit.traveller_ids) {
        await run(
          `INSERT INTO open_credits (trip_id, client_id, created_by, row_key, ${CREDIT_FIELDS.join(', ')})
           VALUES (@trip_id, @client_id, @created_by, @row_key, ${CREDIT_FIELDS.map((f) => '@' + f).join(', ')})`,
          { ...fields, trip_id: tripId, client_id: clientId, created_by: userId, row_key: rowKey },
        );
      }
      continue;
    }
    await run(
      `INSERT INTO trip_itinerary (trip_id, position, ${ITINERARY_FIELDS.join(', ')})
       VALUES (@trip_id, @position, ${ITINERARY_FIELDS.map((f) => '@' + f).join(', ')})`,
      { ...fields, trip_id: tripId, position: position++ },
    );
  }
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
  phase: 'recent' | 'upcoming' | 'past' | 'inactive' | 'cancelled';
}

const TRIP_FIELDS = ['name', 'company_id', 'origin', 'departure_date', 'return_date', 'trip_type', 'status', 'notes'] as const;

/** When the trip starts and ends, as local 'YYYY-MM-DDTHH:MM' text, from its rows' dates and times. */
const START_SQL = `COALESCE(
  (SELECT MIN(it.departure_date || 'T' || COALESCE(it.departure_time, '00:00')) FROM trip_itinerary it WHERE it.trip_id = t.id),
  t.departure_date || 'T00:00')`;
const END_SQL = `COALESCE(
  (SELECT MAX(COALESCE(it.arrival_date, it.departure_date) || 'T' ||
     COALESCE(it.arrival_time, CASE WHEN it.arrival_date IS NULL THEN it.departure_time END, '23:59'))
   FROM trip_itinerary it WHERE it.trip_id = t.id),
  COALESCE(t.return_date, t.departure_date) || 'T23:59')`;

/**
 * Recent: departs within the next 48 hours, departed within the last 24, or is
 * still underway. Upcoming: departs later than that. Past: ended more than 24
 * hours ago. Needs the recentWindow() parameters.
 */
const PHASE_SQL = `CASE
  WHEN t.status = 'cancelled' THEN 'cancelled'
  WHEN t.status = 'inactive' THEN 'inactive'
  WHEN ${START_SQL} > @recentTo THEN 'upcoming'
  WHEN ${END_SQL} < @recentFrom THEN 'past'
  ELSE 'recent' END`;

/** 24 hours ago to 48 hours ahead, in the CRM's time zone. */
export function recentWindow(now = new Date()): { recentFrom: string; recentTo: string } {
  const zone = timezone();
  return {
    recentFrom: dateTimeInTz(zone, new Date(now.getTime() - 24 * 3600_000)),
    recentTo: dateTimeInTz(zone, new Date(now.getTime() + 48 * 3600_000)),
  };
}

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

export function createTrip(input: TripInput, userId: number): Promise<number> {
  return tx(async () => {
    const { traveller_ids, itinerary, ...header } = input;
    const id = await insert(
      `INSERT INTO trips (reference, ${TRIP_FIELDS.join(', ')}, created_by)
       VALUES (@reference, ${TRIP_FIELDS.map((f) => '@' + f).join(', ')}, @created_by)`,
      { ...header, ...tripDatesFrom(staying(itinerary)), reference: `pending-${crypto.randomUUID()}`, created_by: userId },
    );
    await run(`UPDATE trips SET reference = 'TRP-' || to_char(created_at, 'YYYY') || '-' || lpad(id::text, 5, '0') WHERE id = ?`, [id]);
    await replaceTravellers(id, traveller_ids);
    await replaceItinerary(id, itinerary, userId);
    return id;
  });
}

/** Rows that stay on the trip set its dates; when every row becomes open credit, those rows do. */
const staying = (itinerary: ItineraryFormItem[]) => {
  const rows = itinerary.filter((i) => !i.open_credit?.traveller_ids.length);
  return rows.length ? rows : itinerary;
};

/** With no rows at all (everything already moved to open credit) the trip keeps its dates. */
export function updateTrip(id: number, input: TripInput, userId: number | null): Promise<void> {
  return tx(async () => {
    const { traveller_ids, itinerary, ...header } = input;
    await updateRow('trips', id, { ...header, ...(itinerary.length ? tripDatesFrom(staying(itinerary)) : {}) }, TRIP_FIELDS);
    await replaceTravellers(id, traveller_ids);
    await replaceItinerary(id, itinerary, userId);
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
    { id, today, includeDeleted, ...recentWindow() },
  );
}

/** The id of a live trip by its reference, e.g. TRP-2026-00012 (any case). */
export function tripIdByReference(reference: string): Promise<number | undefined> {
  return value<number | undefined>('SELECT id FROM trips WHERE upper(reference) = upper(?) AND deleted_at IS NULL', [reference.trim()]);
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
  /** 'passed', 'missing' (needs a quality check) or null (doesn't need one). */
  qc_status: 'passed' | 'missing' | null;
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

  if (s.filter !== 'all') {
    where.push(`(${PHASE_SQL}) = @phase`);
    Object.assign(params, { phase: s.filter }, recentWindow());
  }
  if (s.companyId) {
    where.push('t.company_id = @companyId');
    params.companyId = s.companyId;
  }
  if (s.travellerId) {
    where.push('EXISTS (SELECT 1 FROM trip_travellers tt WHERE tt.trip_id = t.id AND tt.client_id = @travellerId)');
    params.travellerId = s.travellerId;
  }
  // Every word has to match somewhere: the trip, its company, its itinerary (places, conf. no., PNR) or a traveller.
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
        OR EXISTS (SELECT 1 FROM trip_itinerary it WHERE it.trip_id = t.id AND (${['it.origin', 'it.destination', 'it.name', 'it.airline', 'it.flight_number', 'it.confirmation_number', 'it.gds_pnr'].map(like).join(' OR ')}))
        OR EXISTS (SELECT 1 ${TRAVELLERS_OF_TRIP} AND (${like('c.first_name')} OR ${like('c.last_name')}))
      )`);
    });
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await query<TripListRow>(
    `SELECT * FROM (
       SELECT t.*, co.name AS company_name, ${PHASE_SQL} AS phase,
         COALESCE(
           (SELECT string_agg(it.destination, ', ' ORDER BY it.position) FROM trip_itinerary it
            WHERE it.trip_id = t.id AND it.destination IS NOT NULL),
           (SELECT string_agg(sg.city, ', ' ORDER BY sg.position) FROM trip_segments sg WHERE sg.trip_id = t.id)
         ) AS destinations,
         (SELECT string_agg(c.first_name || ' ' || c.last_name, ', ' ORDER BY lower(c.last_name)) ${TRAVELLERS_OF_TRIP}) AS traveller_names,
         (SELECT COUNT(*) ${TRAVELLERS_OF_TRIP}) AS traveller_count,
         ${OPEN_TICKETS} AS open_tickets,
         ${QC_STATUS_SQL} AS qc_status
       FROM trips t LEFT JOIN companies co ON co.id = t.company_id
       ${whereSql}
     ) s
     ORDER BY ${orderBy(TRIP_SORTS, s.sort, s.dir, 'departure')}
     LIMIT @limit OFFSET @offset`,
    { ...params, ...recentWindow(), today: s.today, limit: s.limit, offset: s.offset },
  );
  const total = await value<number>(`SELECT COUNT(*) FROM trips t ${whereSql}`, params);
  return { rows, total };
}

/** Active trips departing more than 48 hours from now (the Trips list's Upcoming). */
export function countUpcomingTrips(): Promise<number> {
  return countPhase('upcoming');
}

/** Active trips departing within 48 hours, departed within the last 24, or underway (the Trips list's Recent). */
export function countRecentTrips(): Promise<number> {
  return countPhase('recent');
}

function countPhase(phase: 'recent' | 'upcoming'): Promise<number> {
  return value<number>(`SELECT COUNT(*) FROM trips t WHERE t.deleted_at IS NULL AND (${PHASE_SQL}) = @phase`, { ...recentWindow(), phase });
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
  const itinerary = await query('SELECT * FROM trip_itinerary WHERE trip_id = ? ORDER BY position, id', [id]);

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

  const { rows: openCredits } = await searchOpenCredits({ ...ALL_CREDITS, tripId: id });

  return {
    trip,
    travellers,
    itinerary,
    open_credits: openCredits,
    destinations,
    flights,
    hotels: await listBookings('hotels', id),
    cars: await listBookings('cars', id),
    cruises: await listBookings('cruises', id),
    documents,
  };
}

/** Itinerary rows of many trips, in each trip's order (for exports). */
export function itineraryFor(tripIds: number[]): Promise<(ItineraryInput & { trip_id: number })[]> {
  if (!tripIds.length) return Promise.resolve([]);
  return query(`SELECT * FROM trip_itinerary WHERE trip_id IN (${tripIds.join(',')}) ORDER BY trip_id, position, id`);
}

// ---------------------------------------------------------------- open credits

export const CREDIT_STATUSES = ['open', 'used', 'refunded', 'expired'] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export interface OpenCreditRow extends Omit<ItineraryInput, 'type'> {
  id: number;
  /** Shared by the credits made from the same trip row. */
  row_key: string;
  type: (typeof CREDIT_TYPES)[number];
  trip_id: number;
  client_id: number;
  status: CreditStatus;
  notes: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  created_at: string;
  trip_reference: string;
  trip_name: string;
  company_id: number | null;
  company_name: string | null;
  first_name: string;
  last_name: string;
}

export interface CreditSearch {
  q: string;
  /** 'all' for every status. */
  status: CreditStatus | 'all';
  companyId: number | null;
  travellerId: number | null;
  tripId: number | null;
  limit: number;
  offset: number;
}

const ALL_CREDITS: CreditSearch = { q: '', status: 'all', companyId: null, travellerId: null, tripId: null, limit: 500, offset: 0 };

/** Open credits of live trips and travellers, by company, then traveller, then date. */
export async function searchOpenCredits(s: CreditSearch): Promise<{ rows: OpenCreditRow[]; total: number }> {
  const where = ['t.deleted_at IS NULL', 'c.deleted_at IS NULL'];
  const params: Record<string, Bindable> = {};
  if (s.status !== 'all') {
    where.push('oc.status = @status');
    params.status = s.status;
  }
  if (s.companyId) {
    where.push('t.company_id = @companyId');
    params.companyId = s.companyId;
  }
  if (s.travellerId) {
    where.push('oc.client_id = @travellerId');
    params.travellerId = s.travellerId;
  }
  if (s.tripId) {
    where.push('oc.trip_id = @tripId');
    params.tripId = s.tripId;
  }
  s.q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .forEach((word, i) => {
      params[`q${i}`] = likePattern(word);
      const cols = ['t.reference', 't.name', 'co.name', 'c.first_name', 'c.last_name', 'oc.name', 'oc.airline', 'oc.flight_number', 'oc.origin', 'oc.destination', 'oc.confirmation_number', 'oc.gds_pnr'];
      where.push(`(${cols.map((col) => `${col} ILIKE @q${i} ESCAPE '\'`).join(' OR ')})`);
    });
  const from = `FROM open_credits oc
    JOIN trips t ON t.id = oc.trip_id
    JOIN clients c ON c.id = oc.client_id
    LEFT JOIN companies co ON co.id = t.company_id
    WHERE ${where.join(' AND ')}`;
  const rows = await query<OpenCreditRow>(
    `SELECT oc.*, t.reference AS trip_reference, t.name AS trip_name, t.company_id, co.name AS company_name,
       c.first_name, c.last_name, u.name AS resolved_by_name
     ${from.replace('WHERE', 'LEFT JOIN users u ON u.id = oc.resolved_by WHERE')}
     ORDER BY co.name IS NULL, lower(co.name), lower(c.last_name), lower(c.first_name), oc.departure_date, oc.id
     LIMIT @limit OFFSET @offset`,
    { ...params, limit: s.limit, offset: s.offset },
  );
  const total = await value<number>(`SELECT COUNT(*) ${from}`, params);
  return { rows, total };
}

export function getOpenCredit(id: number): Promise<OpenCreditRow | undefined> {
  return one<OpenCreditRow>(
    `SELECT oc.*, t.reference AS trip_reference, t.name AS trip_name, c.first_name, c.last_name
     FROM open_credits oc JOIN trips t ON t.id = oc.trip_id JOIN clients c ON c.id = oc.client_id
     WHERE oc.id = ? AND t.deleted_at IS NULL`,
    [id],
  );
}

/** Marks a credit used, refunded or expired (or open again); the trip shows it as changed. */
export function setOpenCreditStatus(credit: OpenCreditRow, status: CreditStatus, notes: string | null, userId: number): Promise<void> {
  return tx(async () => {
    await run(
      `UPDATE open_credits SET status = @status, notes = @notes, updated_at = now(),
         resolved_by = CASE WHEN @status::text = 'open' THEN NULL ELSE @user::integer END,
         resolved_at = CASE WHEN @status::text = 'open' THEN NULL ELSE now() END
       WHERE id = @id`,
      { id: credit.id, status, notes, user: userId },
    );
    await touchTrip(credit.trip_id);
  });
}

/**
 * Puts the row a credit was made from back on its trip (at the end of its
 * section) and removes every credit made from that row. Returns how many
 * credits were removed.
 */
export function moveCreditBack(credit: OpenCreditRow): Promise<number> {
  return tx(async () => {
    const position = await value<number>('SELECT COALESCE(MAX(position), -1) + 1 FROM trip_itinerary WHERE trip_id = ?', [credit.trip_id]);
    await run(
      `INSERT INTO trip_itinerary (trip_id, position, ${ITINERARY_FIELDS.join(', ')})
       VALUES (@trip_id, @position, ${ITINERARY_FIELDS.map((f) => '@' + f).join(', ')})`,
      { ...Object.fromEntries(ITINERARY_FIELDS.map((f) => [f, (credit[f] as Bindable) ?? null])), trip_id: credit.trip_id, position },
    );
    const removed = await value<number>('SELECT COUNT(*) FROM open_credits WHERE row_key = ?', [credit.row_key]);
    await run('DELETE FROM open_credits WHERE row_key = ?', [credit.row_key]);
    const rows = await query<ItineraryInput>('SELECT * FROM trip_itinerary WHERE trip_id = ? ORDER BY position, id', [credit.trip_id]);
    await updateRow('trips', credit.trip_id, tripDatesFrom(rows), ['origin', 'departure_date', 'return_date']);
    await touchTrip(credit.trip_id);
    return removed;
  });
}

export function deleteOpenCredit(credit: OpenCreditRow): Promise<void> {
  return tx(async () => {
    await run('DELETE FROM open_credits WHERE id = ?', [credit.id]);
    await touchTrip(credit.trip_id);
  });
}

export function countOpenCredits(): Promise<number> {
  return value<number>(
    `SELECT COUNT(*) FROM open_credits oc JOIN trips t ON t.id = oc.trip_id JOIN clients c ON c.id = oc.client_id
     WHERE oc.status = 'open' AND t.deleted_at IS NULL AND c.deleted_at IS NULL`,
  );
}
