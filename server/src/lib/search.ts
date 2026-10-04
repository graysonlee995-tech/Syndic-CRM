import { isIsoDate } from './dates.js';

export interface ParsedSearch {
  /** Lower case words; every one must be the start of a word in the client's record. Empty for no text. */
  terms: string[];
  /** A date of birth found in the query (YYYY-MM-DD), if any. */
  dob: string | null;
}

/**
 * Splits text into lower case, accent free words of letters and digits, the
 * same way for stored records and for search input ("Zoë O'Brien" -> zoe, o, brien).
 */
export function tokenize(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Accepts 1985-03-15, 15/03/1985, 15-03-1985 and 15.03.1985 (day first).
function parseDateToken(token: string): string | null {
  if (isIsoDate(token)) return token;
  const m = token.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * Turns free text typed in the search bar into search terms.
 * Every word must match (AND) and each word is treated as a prefix, so
 * "ali kha" finds "Ali Khan". Terms are passed to SQL as parameters only.
 */
export function parseSearch(input: string): ParsedSearch {
  let dob: string | null = null;
  const terms: string[] = [];

  for (const raw of input.trim().split(/\s+/)) {
    if (!raw) continue;
    const date = parseDateToken(raw);
    if (date && !dob) {
      dob = date;
      continue;
    }
    for (const t of tokenize(raw)) if (!terms.includes(t)) terms.push(t);
  }

  return { terms, dob };
}

/** Letters and digits only, so "AB-123 456" also matches "AB123456". */
export function compact(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '');
}
