const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Today's date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTz(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Whole days from `from` to `to` (negative when `to` is in the past). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  return new Date(toUtcMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export interface NextBirthday {
  /** Date of the next birthday on or after `today` (YYYY-MM-DD). */
  date: string;
  daysUntil: number;
  /** Age the person turns on that date. */
  age: number;
}

/** Next birthday on or after `today`. 29 February birthdays fall on 28 February in non-leap years. */
export function nextBirthday(dateOfBirth: string, today: string): NextBirthday {
  const [birthYear, month, day] = dateOfBirth.split('-').map(Number);
  const on = (year: number) => {
    const d = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
    return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  let year = Number(today.slice(0, 4));
  if (on(year) < today) year++;
  const date = on(year);
  return { date, daysUntil: daysBetween(today, date), age: year - birthYear };
}

/** Current HH:MM in the given timezone. */
export function timeInTz(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}
