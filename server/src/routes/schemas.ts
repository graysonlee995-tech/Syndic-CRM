import { z } from 'zod';
import { DOCUMENT_TYPES } from '../db/repo.js';
import { CREDIT_STATUSES, CREDIT_TYPES, ITINERARY_TYPES, TICKET_RESOLUTIONS, TICKET_STATUSES, TRIP_STATUSES, TRIP_TYPES } from '../db/trips.js';
import { isIsoDate } from '../lib/dates.js';
import { canonicalCountry } from '../lib/countries.js';

/** Optional text: trims, and turns empty strings into null. */
export const optText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

/** Optional country, which must be on the agency list (common short forms like "UAE" are accepted). */
export const optCountry = z
  .string()
  .trim()
  .max(100)
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const country = canonicalCountry(v);
    if (!country) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${v}" is not in the country list; choose one from the list` });
      return z.NEVER;
    }
    return country;
  });

export const optDate = z
  .string()
  .trim()
  .nullish()
  .transform((v) => v || null)
  .refine((v) => v === null || isIsoDate(v), 'must be a valid date (YYYY-MM-DD)');

/** Local date and time from <input type="datetime-local">, e.g. 2026-10-09T14:30. */
export const optDateTime = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.slice(0, 16) : null))
  .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) && isIsoDate(v.slice(0, 10))), 'must be a valid date and time');

/** Optional id: accepts a number, a numeric string or empty. */
export const optId = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => (v === '' || v === null || v === undefined ? null : Number(v)))
  .refine((v) => v === null || (Number.isInteger(v) && v > 0), 'must be a valid id');

export const idList = z.array(z.coerce.number().int().positive()).max(500).default([]).transform((a) => [...new Set(a)]);

export const sortSchema = z.object({
  sort: z.string().max(30).optional(),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

/** Traveller and company names are kept in capitals, however they were typed. */
const upperName = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'is required')
    .max(max)
    .transform((v) => v.toUpperCase());

export const clientSchema = z
  .object({
  first_name: upperName(100),
  last_name: upperName(100),
  /** Every company the traveller belongs to. */
  company_ids: idList,
  /** A single company, as older screens and the assistant may send; added to company_ids. */
  company_id: optId,
  date_of_birth: optDate,
  gender: optText(20),
  nationality: optCountry,
  phone: optText(50),
  email: optText(200),
  address_line: optText(300),
  state: optText(100),
  city: optText(100),
  country: optCountry,
  seat_preference: optText(50),
  meal_preference: optText(100),
  cabin_preference: optText(50),
  special_requirements: optText(2000),
  sabre_entry: optText(5000),
  notes: optText(5000),
  })
  .transform(({ company_id, ...c }) => ({ ...c, company_ids: [...new Set([...c.company_ids, ...(company_id ? [company_id] : [])])] }));

/**
 * Extra emails, phone numbers and addresses sent with a company or traveller form.
 * A list that is left out entirely is not changed.
 */
export const contactsSchema = z.object({
  emails: z
    .array(z.object({ label: optText(50), email: z.string().trim().max(200) }))
    .max(50)
    .optional()
    .transform((list) => list?.filter((e) => e.email)),
  phones: z
    .array(z.object({ label: optText(50), number: z.string().trim().max(50) }))
    .max(50)
    .optional()
    .transform((list) => list?.filter((p) => p.number)),
  addresses: z
    .array(z.object({ label: optText(50), address_line: optText(300), state: optText(100), city: optText(100), country: optCountry }))
    .max(50)
    .optional()
    .transform((list) => list?.filter((a) => a.address_line || a.state || a.city || a.country)),
});

export const loyaltySchema = z.object({
  airline: z.string().trim().min(1, 'is required').max(100),
  programme: optText(100),
  member_number: z.string().trim().min(1, 'is required').max(100),
  tier: optText(50),
});

export const companySchema = z.object({
  name: upperName(200),
  primary_contact: optText(200),
  phone: optText(50),
  email: optText(200),
  address_line: optText(300),
  state: optText(100),
  city: optText(100),
  country: optCountry,
  notes: optText(5000),
});

/** Optional time of day, HH:MM (24-hour). */
export const optTime = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.slice(0, 5) : null))
  .refine((v) => v === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'must be a valid time (HH:MM)');

export const itineraryItemSchema = z
  .object({
    type: z.enum(ITINERARY_TYPES),
    airline: optText(100),
    flight_number: optText(20).transform((v) => v?.toUpperCase() ?? null),
    name: optText(2000),
    origin: optText(100),
    destination: optText(100),
    departure_date: z
      .string({ required_error: 'is required' })
      .trim()
      .refine(isIsoDate, 'is required (a valid date)'),
    departure_time: optTime,
    arrival_date: optDate,
    arrival_time: optTime,
    confirmation_number: optText(50),
    // A GDS PNR or a ticket number such as 176-2401234567.
    gds_pnr: optText(30).transform((v) => v?.toUpperCase() ?? null),
    /** Turn this flight or train into open credit for these travellers when the trip is saved. */
    open_credit: z.object({ traveller_ids: idList }).nullish(),
  })
  .refine(
    (i) => !i.open_credit?.traveller_ids.length || (CREDIT_TYPES as readonly string[]).includes(i.type),
    { message: 'only flights, trains and hotels can become open credit', path: ['open_credit'] },
  )
  .refine(
    (i) =>
      !i.arrival_date ||
      `${i.arrival_date}T${i.arrival_time ?? '23:59'}` >= `${i.departure_date}T${i.departure_time ?? '00:00'}`,
    { message: 'must be after the departure', path: ['arrival_date'] },
  );

export const tripSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  company_id: optId,
  trip_type: z.enum(TRIP_TYPES).default('business'),
  status: z.enum(TRIP_STATUSES).default('active'),
  notes: optText(5000),
  traveller_ids: idList,
  // At least one row for a new trip (checked by the route); an existing trip may have only open credits left.
  itinerary: z.array(itineraryItemSchema).max(200),
});

export const creditStatusSchema = z.object({
  status: z.enum(CREDIT_STATUSES),
  notes: optText(2000),
});

/** Field validation per booking kind; keys must match BOOKINGS in db/trips.ts. */
export const bookingSchemas = {
  flights: z.object({
    airline: optText(100),
    flight_number: optText(20),
    from_airport: z.string().trim().min(1, 'is required').max(100),
    to_airport: z.string().trim().min(1, 'is required').max(100),
    departs_at: optDateTime,
    arrives_at: optDateTime,
    cabin_class: optText(50),
    booking_reference: optText(50),
    notes: optText(2000),
  }),
  hotels: z.object({
    name: z.string().trim().min(1, 'is required').max(200),
    city: optText(100),
    address: optText(300),
    check_in: optDate,
    check_out: optDate,
    room_type: optText(100),
    confirmation_number: optText(100),
    notes: optText(2000),
  }),
  cars: z.object({
    provider: z.string().trim().min(1, 'is required').max(100),
    car_type: optText(100),
    pickup_location: optText(200),
    pickup_at: optDateTime,
    dropoff_location: optText(200),
    dropoff_at: optDateTime,
    confirmation_number: optText(100),
    notes: optText(2000),
  }),
  cruises: z.object({
    cruise_line: z.string().trim().min(1, 'is required').max(100),
    ship: optText(100),
    embark_port: optText(100),
    embark_date: optDate,
    disembark_port: optText(100),
    disembark_date: optDate,
    cabin: optText(50),
    confirmation_number: optText(100),
    notes: optText(2000),
  }),
} as const;

export const ticketSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  ticket_number: optText(50),
  status: z.enum(TICKET_STATUSES).default('issued'),
  notes: optText(2000),
});

export const resolutionSchema = z.object({
  resolution: z.enum(TICKET_RESOLUTIONS),
  notes: optText(2000),
});

export const documentSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    /** What an "Others" document is; required for that type. */
    other_type: optText(100),
    document_number: optText(100),
    issuing_country: optCountry,
    issue_date: optDate,
    expiry_date: optDate,
    notes: optText(2000),
  })
  .refine((d) => d.type !== 'other' || d.other_type, { message: 'is required for Others: say what the document is', path: ['other_type'] })
  .transform((d) => ({ ...d, other_type: d.type === 'other' ? d.other_type : null }));

export const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
