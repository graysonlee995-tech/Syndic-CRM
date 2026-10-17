import { z } from 'zod';
import { DOCUMENT_TYPES } from '../db/repo.js';
import { ITINERARY_TYPES, TICKET_RESOLUTIONS, TICKET_STATUSES, TRIP_STATUSES, TRIP_TYPES } from '../db/trips.js';
import { isIsoDate } from '../lib/dates.js';

/** Optional text: trims, and turns empty strings into null. */
export const optText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

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

export const clientSchema = z.object({
  first_name: z.string().trim().min(1, 'is required').max(100),
  last_name: z.string().trim().min(1, 'is required').max(100),
  company_id: optId,
  date_of_birth: optDate,
  gender: optText(20),
  nationality: optText(80),
  phone: optText(50),
  email: optText(200),
  address_line: optText(300),
  city: optText(100),
  country: optText(100),
  seat_preference: optText(50),
  meal_preference: optText(100),
  cabin_preference: optText(50),
  special_requirements: optText(2000),
  notes: optText(5000),
});

export const loyaltySchema = z.object({
  airline: z.string().trim().min(1, 'is required').max(100),
  programme: optText(100),
  member_number: z.string().trim().min(1, 'is required').max(100),
  tier: optText(50),
});

export const companySchema = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  primary_contact: optText(200),
  phone: optText(50),
  email: optText(200),
  address_line: optText(300),
  city: optText(100),
  country: optText(100),
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
    gds_pnr: optText(20).transform((v) => v?.toUpperCase() ?? null),
  })
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
  status: z.enum(TRIP_STATUSES).default('planned'),
  notes: optText(5000),
  traveller_ids: idList,
  itinerary: z
    .array(itineraryItemSchema)
    .min(1, 'add at least one item (flight, hotel, car...) with its departure date')
    .max(100),
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

export const documentSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  document_number: optText(100),
  issuing_country: optText(100),
  issue_date: optDate,
  expiry_date: optDate,
  notes: optText(2000),
});

export const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
