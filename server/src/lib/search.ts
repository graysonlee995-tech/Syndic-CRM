import { isIsoDate } from './dates.js';

export interface ParsedSearch {
  /** Words that must all appear in the traveller's search text (lower case, no accents). */
  terms: string[];
  /** A date of birth found in the query (YYYY-MM-DD), if any. */
  dob: string | null;
}

// Accepts 1985-03-15, 15/03/1985, 15-03-1985 and 15.03.1985 (day first).
function parseDateToken(token: string): string | null {
  if (isIsoDate(token)) return token;
  const m = token.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** Lower case without accents, so "José" and "jose" match. */
export function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Splits text typed in the search bar into words. Every word must match
 * somewhere (AND) as part of a word, so "ali kha" finds "Ali Khan".
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
    const cleaned = normalize(raw.replace(/"/g, ''));
    if (!/[\p{L}\p{N}]/u.test(cleaned)) continue;
    terms.push(cleaned);
  }

  return { terms: terms.slice(0, 10), dob };
}

/** Letters and digits only, so "AB-123 456" also matches "AB123456". */
export function compact(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '');
}
