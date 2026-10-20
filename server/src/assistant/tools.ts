import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import {
  audit,
  clientsWithBirthdays,
  countClients,
  countDocuments,
  createClient,
  documentsExpiringBy,
  getClient,
  listDocuments,
  listLoyalty,
  searchClients,
  type PublicUser,
} from '../db/repo.js';
import { createCompany, getCompany, searchCompanies } from '../db/companies.js';
import {
  countUpcomingTrips,
  createTrip,
  getTrip,
  getTripDetail,
  searchTrips,
  TRIP_FILTERS,
  tripIdByReference,
  updateTrip,
  type TripInput,
} from '../db/trips.js';
import { upcomingBirthdays } from '../jobs/birthdays.js';
import { addDays, daysBetween, todayInTz } from '../lib/dates.js';
import { parseSearch } from '../lib/search.js';
import { clientSchema, companySchema, itineraryItemSchema, tripSchema } from '../routes/schemas.js';

/**
 * What the CRM assistant can do. Read tools run straight away; write tools
 * (WRITE_TOOLS) only run after the employee approves them in the chat.
 * Passport and ID numbers are never returned to the model.
 */

type Tool = Anthropic.Beta.BetaTool;

const today = () => todayInTz(config.timezone);

/** A trip given as a reference (TRP-2026-00012) or a numeric id. */
const tripRef = { type: 'string', description: 'Trip reference such as TRP-2026-00012, or the numeric trip id' } as const;

const ITINERARY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['flight', 'hotel', 'car', 'cruise', 'train', 'transfer', 'other'] },
    origin: { type: 'string', description: 'Airport code or city; for a hotel, the hotel name' },
    destination: { type: 'string', description: 'Airport code or city; for a hotel, its city' },
    departure_date: { type: 'string', description: 'YYYY-MM-DD (for a hotel: check-in)' },
    departure_time: { type: 'string', description: 'HH:MM 24-hour, local time' },
    arrival_date: { type: 'string', description: 'YYYY-MM-DD (for a hotel: check-out)' },
    arrival_time: { type: 'string', description: 'HH:MM 24-hour, local time' },
    confirmation_number: { type: 'string' },
    gds_pnr: { type: 'string', description: 'Airline / GDS booking reference' },
  },
  required: ['type', 'departure_date'],
} as const;

export const TOOLS: Tool[] = [
  {
    name: 'search_trips',
    description:
      'Find trips. Call this whenever the user asks about trips, bookings, travel dates, PNRs or confirmation numbers. ' +
      'The query matches trip reference, name, company, traveller names, itinerary places, confirmation numbers and GDS PNRs.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match; leave empty to list all' },
        filter: { type: 'string', enum: [...TRIP_FILTERS], description: 'upcoming, ongoing, past, cancelled, open_tickets or all' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
  },
  {
    name: 'get_trip',
    description: 'Full details of one trip: travellers, itinerary, flight tickets, hotels, cars, cruises and documents.',
    input_schema: { type: 'object', properties: { trip: tripRef }, required: ['trip'] },
  },
  {
    name: 'search_travellers',
    description:
      'Find travellers (clients) by name, phone, email, address, city or date of birth (YYYY-MM-DD or DD/MM/YYYY). ' +
      'Use it to get traveller ids before creating trips or adding travellers to a trip.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        company_id: { type: 'integer', description: 'Only travellers of this company' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
  },
  {
    name: 'get_traveller',
    description:
      'Details of one traveller: contact details, travel preferences, documents (type, issuing country and expiry only), ' +
      'frequent flyer memberships and their trips.',
    input_schema: { type: 'object', properties: { traveller_id: { type: 'integer' } }, required: ['traveller_id'] },
  },
  {
    name: 'search_companies',
    description: 'Find companies by name, contact, email, phone or city. Use it to get a company id.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25 } } },
  },
  {
    name: 'get_company',
    description: "Details of one company with its travellers and upcoming trips.",
    input_schema: { type: 'object', properties: { company_id: { type: 'integer' } }, required: ['company_id'] },
  },
  {
    name: 'expiring_documents',
    description: 'Traveller documents (passports, visas, IDs) that expire within the given number of days, including already expired ones.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 0, maximum: 730 } }, required: ['days'] },
  },
  {
    name: 'crm_overview',
    description: 'Headline numbers: travellers, documents, upcoming trips, expired and soon-expiring documents, birthdays in the next 30 days.',
    input_schema: { type: 'object', properties: {} },
  },
  // ---------------------------------------------------------------- write tools (need approval)
  {
    name: 'create_trip',
    description:
      'Create a trip. The employee sees a confirmation card and must approve before it is saved. ' +
      'Look up company and traveller ids first. Every itinerary item needs a type and departure_date.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        company_id: { type: 'integer' },
        traveller_ids: { type: 'array', items: { type: 'integer' } },
        trip_type: { type: 'string', enum: ['business', 'leisure', 'group', 'event', 'other'] },
        status: { type: 'string', enum: ['planned', 'confirmed', 'cancelled'] },
        notes: { type: 'string' },
        itinerary: { type: 'array', items: ITINERARY_ITEM_SCHEMA, minItems: 1 },
      },
      required: ['name', 'itinerary'],
    },
  },
  {
    name: 'add_itinerary_items',
    description: "Add flights, hotels, cars and so on to an existing trip's itinerary (needs approval).",
    input_schema: {
      type: 'object',
      properties: { trip: tripRef, items: { type: 'array', items: ITINERARY_ITEM_SCHEMA, minItems: 1 } },
      required: ['trip', 'items'],
    },
  },
  {
    name: 'update_trip',
    description: "Change a trip's name, status (planned, confirmed, cancelled), type, notes or company (needs approval).",
    input_schema: {
      type: 'object',
      properties: {
        trip: tripRef,
        name: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'confirmed', 'cancelled'] },
        trip_type: { type: 'string', enum: ['business', 'leisure', 'group', 'event', 'other'] },
        notes: { type: 'string' },
        company_id: { type: 'integer' },
      },
      required: ['trip'],
    },
  },
  {
    name: 'add_travellers_to_trip',
    description: 'Add existing travellers to a trip (needs approval). Look up their ids with search_travellers first.',
    input_schema: {
      type: 'object',
      properties: { trip: tripRef, traveller_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 } },
      required: ['trip', 'traveller_ids'],
    },
  },
  {
    name: 'create_traveller',
    description: 'Create a traveller (needs approval). Search first to avoid creating a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        company_id: { type: 'integer' },
        date_of_birth: { type: 'string', description: 'YYYY-MM-DD' },
        nationality: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        state: { type: 'string', description: 'State or province' },
        city: { type: 'string' },
        country: { type: 'string', description: 'Country name in English, e.g. Pakistan, United Arab Emirates' },
        notes: { type: 'string' },
      },
      required: ['first_name', 'last_name'],
    },
  },
  {
    name: 'create_company',
    description: 'Create a company (needs approval). Search first to avoid creating a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        primary_contact: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        state: { type: 'string', description: 'State or province' },
        city: { type: 'string' },
        country: { type: 'string', description: 'Country name in English, e.g. Pakistan, United Arab Emirates' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
];

export const WRITE_TOOLS = new Set(['create_trip', 'add_itinerary_items', 'update_trip', 'add_travellers_to_trip', 'create_traveller', 'create_company']);

/** A tool failure Claude can read and act on (shown to it as an error result). */
export class ToolError extends Error {}

const limit = (v: unknown) => Math.min(Math.max(Number(v) || 10, 1), 25);

async function resolveTrip(value: unknown) {
  const raw = String(value ?? '').trim();
  const id = /^\d+$/.test(raw) ? Number(raw) : await tripIdByReference(raw);
  const trip = id ? await getTrip(id, today()) : undefined;
  if (!trip) throw new ToolError(`No trip found for "${raw}". Use search_trips to find it.`);
  return trip;
}

async function assertTravellers(ids: number[]) {
  for (const id of ids) {
    if (!(await getClient(id))) throw new ToolError(`Traveller id ${id} does not exist. Use search_travellers.`);
  }
}

async function assertCompany(id: number | null) {
  if (id !== null && !(await getCompany(id))) throw new ToolError(`Company id ${id} does not exist. Use search_companies.`);
}

/** The trip as the trip form would send it, so updates keep everything not being changed. */
async function tripInput(tripId: number): Promise<TripInput> {
  const d = (await getTripDetail(tripId, today()))!;
  return {
    name: d.trip.name,
    company_id: d.trip.company_id,
    trip_type: d.trip.trip_type,
    status: d.trip.status,
    notes: d.trip.notes,
    traveller_ids: (d.travellers as { id: number }[]).map((t) => t.id),
    itinerary: tripSchema.shape.itinerary.parse(d.itinerary),
  };
}

const parse = <S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ToolError(`Invalid input: ${issue.path.join('.') || 'input'} ${issue.message}`);
  }
  return result.data;
};

const VIA = ' (via assistant)';

type Handler = (input: Record<string, unknown>, user: PublicUser) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  async search_trips(input) {
    const filter = TRIP_FILTERS.includes(input.filter as never) ? (input.filter as (typeof TRIP_FILTERS)[number]) : 'all';
    const { rows, total } = await searchTrips({
      q: String(input.query ?? ''),
      filter,
      companyId: null,
      travellerId: null,
      sort: 'departure',
      dir: filter === 'past' || filter === 'all' ? 'desc' : 'asc',
      today: today(),
      limit: limit(input.limit),
      offset: 0,
    });
    return {
      total,
      trips: rows.map((t) => ({
        reference: t.reference,
        id: t.id,
        name: t.name,
        company: t.company_name,
        travellers: t.traveller_names,
        origin: t.origin,
        destinations: t.destinations,
        departure_date: t.departure_date,
        return_date: t.return_date,
        status: t.status,
        phase: t.phase,
        open_tickets: t.open_tickets,
      })),
    };
  },

  async get_trip(input) {
    const trip = await resolveTrip(input.trip);
    const d = (await getTripDetail(trip.id, today()))!;
    return {
      ...d,
      travellers: (d.travellers as Record<string, unknown>[]).map(({ email: _e, ...t }) => t),
      documents: (d.documents as { title: string }[]).map((doc) => doc.title),
    };
  },

  async search_travellers(input) {
    const parsed = parseSearch(String(input.query ?? ''));
    const { rows, total } = await searchClients({
      terms: parsed.terms,
      dob: parsed.dob,
      nationality: null,
      docType: null,
      companyId: input.company_id ? Number(input.company_id) : null,
      sort: 'name',
      dir: 'asc',
      today: today(),
      limit: limit(input.limit),
      offset: 0,
    });
    return {
      total,
      travellers: rows.map((c) => ({
        id: c.id,
        name: `${c.first_name} ${c.last_name}`,
        company: c.company_name,
        company_id: c.company_id,
        nationality: c.nationality,
        date_of_birth: c.date_of_birth,
        phone: c.phone,
        email: c.email,
        earliest_document_expiry: c.earliest_expiry,
        upcoming_trips: c.upcoming_trips,
      })),
    };
  },

  async get_traveller(input) {
    const client = await getClient(Number(input.traveller_id));
    if (!client) throw new ToolError(`No traveller with id ${input.traveller_id}.`);
    const documents = (await listDocuments(client.id)).map((d) => ({
      type: d.type,
      issuing_country: d.issuing_country,
      expiry_date: d.expiry_date,
      days_until_expiry: d.expiry_date ? daysBetween(today(), d.expiry_date) : null,
      has_scan: Boolean(d.file_name),
    }));
    const loyalty = (await listLoyalty(client.id)).map((m) => ({
      airline: m.airline,
      programme: m.programme,
      tier: m.tier,
      number_ends_with: m.member_number.slice(-4),
    }));
    const trips = await searchTrips({
      q: '', filter: 'all', companyId: null, travellerId: client.id, sort: 'departure', dir: 'desc', today: today(), limit: 25, offset: 0,
    });
    return {
      traveller: client,
      documents,
      frequent_flyer: loyalty,
      trips: trips.rows.map((t) => ({ reference: t.reference, name: t.name, departure_date: t.departure_date, phase: t.phase })),
    };
  },

  async search_companies(input) {
    const { rows, total } = await searchCompanies({
      q: String(input.query ?? ''), sort: 'name', dir: 'asc', today: today(), limit: limit(input.limit), offset: 0,
    });
    return { total, companies: rows };
  },

  async get_company(input) {
    const company = await getCompany(Number(input.company_id));
    if (!company) throw new ToolError(`No company with id ${input.company_id}.`);
    const travellers = await searchClients({
      terms: [], dob: null, nationality: null, docType: null, companyId: company.id, sort: 'name', dir: 'asc', today: today(), limit: 100, offset: 0,
    });
    const trips = await searchTrips({
      q: '', filter: 'upcoming', companyId: company.id, travellerId: null, sort: 'departure', dir: 'asc', today: today(), limit: 25, offset: 0,
    });
    return {
      company,
      travellers: travellers.rows.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}` })),
      upcoming_trips: trips.rows.map((t) => ({ reference: t.reference, name: t.name, departure_date: t.departure_date })),
    };
  },

  async expiring_documents(input) {
    const days = Math.min(Math.max(Number(input.days) || 0, 0), 730);
    const docs = await documentsExpiringBy(addDays(today(), days));
    return docs.map((d) => ({
      traveller_id: d.client_id,
      traveller: `${d.first_name} ${d.last_name}`,
      type: d.type,
      expiry_date: d.expiry_date,
      days_left: daysBetween(today(), d.expiry_date),
    }));
  },

  async crm_overview() {
    const docs = (await documentsExpiringBy(addDays(today(), 90))).map((d) => daysBetween(today(), d.expiry_date));
    return {
      today: today(),
      travellers: await countClients(),
      documents: await countDocuments(),
      upcoming_trips: await countUpcomingTrips(today()),
      expired_documents: docs.filter((n) => n < 0).length,
      expiring_within_30_days: docs.filter((n) => n >= 0 && n <= 30).length,
      birthdays_next_30_days: upcomingBirthdays(await clientsWithBirthdays(), 30, today()).map((c) => ({
        name: `${c.first_name} ${c.last_name}`,
        date: c.birthday.date,
        turns: c.birthday.age,
      })),
    };
  },

  // ---------------------------------------------------------------- write tools

  async create_trip(input, user) {
    const data = parse(tripSchema, input);
    await assertCompany(data.company_id);
    await assertTravellers(data.traveller_ids);
    const id = await createTrip(data, user.id);
    const trip = (await getTrip(id, today()))!;
    await audit(user, 'trip_created', 'trip', id, `${trip.reference} ${trip.name}${VIA}`);
    return { created: trip.reference, id, link: `/trips/${id}` };
  },

  async add_itinerary_items(input, user) {
    const trip = await resolveTrip(input.trip);
    const items = parse(z.array(itineraryItemSchema).min(1).max(50), input.items);
    const current = await tripInput(trip.id);
    await updateTrip(trip.id, { ...current, itinerary: [...current.itinerary, ...items] });
    await audit(user, 'trip_updated', 'trip', trip.id, `added ${items.length} itinerary item(s)${VIA}`);
    return { updated: trip.reference, itinerary_items: current.itinerary.length + items.length, link: `/trips/${trip.id}` };
  },

  async update_trip(input, user) {
    const trip = await resolveTrip(input.trip);
    const changes = parse(tripSchema.pick({ name: true, status: true, trip_type: true, notes: true, company_id: true }).partial(), input);
    if (changes.company_id !== undefined) await assertCompany(changes.company_id);
    const current = await tripInput(trip.id);
    const defined = Object.fromEntries(Object.entries(changes).filter(([k]) => k in (input as object)));
    await updateTrip(trip.id, { ...current, ...defined });
    await audit(user, 'trip_updated', 'trip', trip.id, `${Object.keys(defined).join(', ')}${VIA}`);
    return { updated: trip.reference, changed: Object.keys(defined), link: `/trips/${trip.id}` };
  },

  async add_travellers_to_trip(input, user) {
    const trip = await resolveTrip(input.trip);
    const ids = parse(z.array(z.number().int().positive()).min(1).max(100), input.traveller_ids);
    await assertTravellers(ids);
    const current = await tripInput(trip.id);
    await updateTrip(trip.id, { ...current, traveller_ids: [...new Set([...current.traveller_ids, ...ids])] });
    await audit(user, 'trip_updated', 'trip', trip.id, `added traveller(s) ${ids.join(', ')}${VIA}`);
    return { updated: trip.reference, link: `/trips/${trip.id}` };
  },

  async create_traveller(input, user) {
    const data = parse(clientSchema, input);
    await assertCompany(data.company_id);
    const id = await createClient(data, user.id);
    await audit(user, 'client_created', 'client', id, `${data.first_name} ${data.last_name}${VIA}`);
    return { created: `${data.first_name} ${data.last_name}`, id, link: `/travellers/${id}` };
  },

  async create_company(input, user) {
    const data = parse(companySchema, input);
    const id = await createCompany(data, user.id);
    await audit(user, 'company_created', 'company', id, `${data.name}${VIA}`);
    return { created: data.name, id, link: `/companies/${id}` };
  },
};

/** Runs one tool; returns its JSON result, or throws ToolError for problems Claude should see. */
export async function runTool(name: string, input: unknown, user: PublicUser): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolError(`Unknown tool ${name}`);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ToolError('Tool input must be an object');
  return handler(input as Record<string, unknown>, user);
}

/** One line for the confirmation card, so the employee knows exactly what they approve. */
export function describeAction(name: string, input: Record<string, unknown>): string {
  const items = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, unknown>[];
  const leg = (i: Record<string, unknown>) =>
    `${i.type ?? 'item'} ${[i.origin, i.destination].filter(Boolean).join(' → ')} on ${i.departure_date ?? '?'}${i.departure_time ? ` ${i.departure_time}` : ''}`;
  switch (name) {
    case 'create_trip':
      return `Create trip "${input.name}" with ${items(input.itinerary).length} itinerary item(s): ${items(input.itinerary).map(leg).join('; ')}` +
        (items(input.traveller_ids).length ? ` and ${items(input.traveller_ids).length} traveller(s)` : '');
    case 'add_itinerary_items':
      return `Add to ${input.trip}: ${items(input.items).map(leg).join('; ')}`;
    case 'update_trip': {
      const { trip, ...changes } = input;
      return `Update ${trip}: ${Object.entries(changes).map(([k, v]) => `${k.replace(/_/g, ' ')} → ${String(v)}`).join(', ')}`;
    }
    case 'add_travellers_to_trip':
      return `Add traveller id(s) ${items(input.traveller_ids).join(', ')} to ${input.trip}`;
    case 'create_traveller':
      return `Create traveller ${input.first_name} ${input.last_name}` + (input.company_id ? ` (company id ${input.company_id})` : '');
    case 'create_company':
      return `Create company "${input.name}"`;
    default:
      return name;
  }
}
