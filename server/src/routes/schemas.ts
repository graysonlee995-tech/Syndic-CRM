import { z } from 'zod';
import { DOCUMENT_TYPES } from '../db/repo.js';
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

export const clientSchema = z.object({
  first_name: z.string().trim().min(1, 'is required').max(100),
  last_name: z.string().trim().min(1, 'is required').max(100),
  date_of_birth: optDate,
  gender: optText(20),
  nationality: optText(80),
  phone: optText(50),
  email: optText(200),
  address_line: optText(300),
  city: optText(100),
  country: optText(100),
  notes: optText(5000),
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
