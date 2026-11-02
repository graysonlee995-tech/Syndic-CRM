import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeDueAlerts, reachedThreshold } from '../src/jobs/expiryAlerts.js';
import { computeDueBirthdays } from '../src/jobs/birthdays.js';
import { addDays, daysBetween, isIsoDate, nextBirthday, todayInTz } from '../src/lib/dates.js';
import { decrypt, detectMime, encrypt } from '../src/lib/files.js';
import { parseSearch } from '../src/lib/search.js';
import { tripDatesFrom, type ItineraryInput } from '../src/db/trips.js';
import { MIGRATIONS, upgradeBackupRow } from '../src/db/schema.js';

const THRESHOLDS = [90, 30, 7, 0];

describe('reachedThreshold', () => {
  it.each([
    [120, null],
    [91, null],
    [90, 90],
    [31, 90],
    [30, 30],
    [8, 30],
    [7, 7],
    [1, 7],
    [0, 0],
    [-400, 0],
  ])('%i days left -> %s', (daysLeft, expected) => {
    expect(reachedThreshold(daysLeft, THRESHOLDS)).toBe(expected);
  });

  it('returns null when there are no thresholds', () => {
    expect(reachedThreshold(-1, [])).toBeNull();
  });
});

describe('computeDueAlerts', () => {
  const today = '2026-01-01';
  const doc = (id: number, days: number) => ({ id, expiry_date: addDays(today, days) });

  it('picks only documents that reached a threshold', () => {
    const due = computeDueAlerts([doc(1, 200), doc(2, 29), doc(3, -3)], THRESHOLDS, new Set(), today);
    expect(due.map((d) => [d.doc.id, d.threshold, d.daysLeft])).toEqual([
      [3, 0, -3],
      [2, 30, 29],
    ]);
  });

  it('never repeats an alert already sent for the same threshold', () => {
    const due = computeDueAlerts([doc(1, 29)], THRESHOLDS, new Set(['1:30']), today);
    expect(due).toEqual([]);
  });

  it('sends again once the next threshold is reached', () => {
    const due = computeDueAlerts([doc(1, 6)], THRESHOLDS, new Set(['1:90', '1:30']), today);
    expect(due.map((d) => d.threshold)).toEqual([7]);
  });
});

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate('15/03/1985')).toBe(false);
  });

  it('counts days across month and year ends', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysBetween('2026-03-10', '2026-03-01')).toBe(-9);
  });

  it('computes today in the configured timezone', () => {
    // 20:00 UTC on 31 Dec is already 1 Jan in Karachi (UTC+5).
    expect(todayInTz('Asia/Karachi', new Date('2025-12-31T20:00:00Z'))).toBe('2026-01-01');
  });
});

describe('nextBirthday', () => {
  it('finds a birthday later this year', () => {
    expect(nextBirthday('1985-03-15', '2026-03-10')).toEqual({ date: '2026-03-15', daysUntil: 5, age: 41 });
  });

  it('counts today as the birthday', () => {
    expect(nextBirthday('1985-03-15', '2026-03-15')).toEqual({ date: '2026-03-15', daysUntil: 0, age: 41 });
  });

  it('rolls over to next year once the birthday has passed', () => {
    expect(nextBirthday('1990-01-02', '2026-12-30')).toEqual({ date: '2027-01-02', daysUntil: 3, age: 37 });
  });

  it('puts 29 February on 28 February in non-leap years', () => {
    expect(nextBirthday('2000-02-29', '2027-02-01').date).toBe('2027-02-28');
    expect(nextBirthday('2000-02-29', '2028-02-01').date).toBe('2028-02-29');
  });
});

describe('computeDueBirthdays', () => {
  const clients = [
    { id: 1, date_of_birth: '1985-03-15' },
    { id: 2, date_of_birth: '1990-03-11' },
    { id: 3, date_of_birth: '1970-06-01' },
  ];

  it('picks birthdays within the window, soonest first', () => {
    const due = computeDueBirthdays(clients, 7, new Set(), '2026-03-10');
    expect(due.map((c) => [c.id, c.birthday.daysUntil])).toEqual([
      [2, 1],
      [1, 5],
    ]);
  });

  it('reminds once per client per year', () => {
    expect(computeDueBirthdays(clients, 7, new Set(['1:2026', '2:2026']), '2026-03-10')).toEqual([]);
    expect(computeDueBirthdays(clients, 7, new Set(['1:2025']), '2026-03-10').map((c) => c.id)).toEqual([2, 1]);
  });
});

describe('tripDatesFrom', () => {
  const item = (o: Partial<ItineraryInput>): ItineraryInput => ({
    type: 'flight',
    airline: null,
    flight_number: null,
    name: null,
    origin: null,
    destination: null,
    departure_date: '2026-11-20',
    departure_time: null,
    arrival_date: null,
    arrival_time: null,
    confirmation_number: null,
    gds_pnr: null,
    ...o,
  });

  it('starts at the first departure, not a same-day hotel without a time', () => {
    const dates = tripDatesFrom([
      item({ origin: 'KHI', departure_time: '09:30', arrival_date: '2026-11-20' }),
      item({ type: 'hotel', name: 'Atlantis', arrival_date: '2026-11-23' }),
    ]);
    expect(dates).toEqual({ origin: 'KHI', departure_date: '2026-11-20', return_date: '2026-11-23' });
  });

  it('uses times when both items have one, and has no return date for a same-day trip', () => {
    const dates = tripDatesFrom([
      item({ origin: 'LHE', departure_time: '18:00' }),
      item({ origin: 'KHI', departure_time: '07:00', arrival_date: '2026-11-20' }),
    ]);
    expect(dates).toEqual({ origin: 'KHI', departure_date: '2026-11-20', return_date: null });
  });
});

describe('parseSearch', () => {
  it('splits into lower-case words without accents or quotes', () => {
    expect(parseSearch('Ali KHA').terms).toEqual(['ali', 'kha']);
    expect(parseSearch('ab" OR x').terms).toEqual(['ab', 'or', 'x']);
    expect(parseSearch('José').terms).toEqual(['jose']);
  });

  it('extracts a date of birth in several formats', () => {
    expect(parseSearch('15/03/1985')).toEqual({ terms: [], dob: '1985-03-15' });
    expect(parseSearch('khan 1985-03-15')).toEqual({ terms: ['khan'], dob: '1985-03-15' });
    expect(parseSearch('31/02/1985').dob).toBeNull();
  });

  it('ignores punctuation-only input', () => {
    expect(parseSearch(' - * ')).toEqual({ terms: [], dob: null });
  });
});

describe('file encryption', () => {
  it('round-trips and does not store plaintext', () => {
    const plain = Buffer.from('%PDF-1.4 passport scan');
    const stored = encrypt(plain);
    expect(stored.includes(plain)).toBe(false);
    expect(decrypt(stored)).toEqual(plain);
  });

  it('rejects tampered data', () => {
    const stored = encrypt(Buffer.from('hello'));
    stored[stored.length - 1] ^= 1;
    expect(() => decrypt(stored)).toThrow();
  });

  it('rejects the wrong key', () => {
    const stored = encrypt(Buffer.from('hello'));
    expect(() => decrypt(stored, crypto.randomBytes(32))).toThrow();
  });

  it('detects allowed file types by content', () => {
    expect(detectMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectMime(Buffer.from('<html>'))).toBeNull();
  });
});

describe('migration 6 (trip sections and statuses)', () => {
  it('moves old itinerary rows into their sections and old statuses to Active', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    for (const sql of MIGRATIONS.slice(0, 5)) await db.exec(sql as string);
    await db.exec(`
      INSERT INTO trips (reference, name, departure_date, status) VALUES ('T1', 'a', '2026-01-01', 'planned'), ('T2', 'b', '2026-01-01', 'cancelled');
      INSERT INTO trip_itinerary (trip_id, position, type, origin, destination, departure_date) VALUES
        (1, 0, 'flight', 'KHI', 'DXB', '2026-01-01'),
        (1, 1, 'hotel', 'Atlantis', 'Dubai', '2026-01-01'),
        (1, 2, 'cruise', 'Dubai', 'Muscat', '2026-01-03'),
        (1, 3, 'transfer', NULL, NULL, '2026-01-05'),
        (1, 4, 'other', 'Desert', NULL, '2026-01-06');
    `);
    await db.exec(MIGRATIONS[5] as string);
    const trips = await db.query<{ status: string }>('SELECT status FROM trips ORDER BY id');
    expect(trips.rows.map((t) => t.status)).toEqual(['active', 'cancelled']);
    const rows = await db.query('SELECT type, name, origin, destination FROM trip_itinerary ORDER BY position');
    expect(rows.rows).toEqual([
      { type: 'flight', name: null, origin: 'KHI', destination: 'DXB' },
      { type: 'hotel', name: 'Atlantis', origin: null, destination: 'Dubai' },
      { type: 'other', name: 'Cruise Dubai → Muscat', origin: null, destination: 'Muscat' },
      { type: 'other', name: 'Transfer', origin: null, destination: null },
      { type: 'other', name: 'Desert', origin: null, destination: null },
    ]);
    // Rows from an old backup are converted the same way.
    expect(upgradeBackupRow('trip_itinerary', { type: 'cruise', origin: 'Dubai', destination: 'Muscat' }, 5)).toMatchObject({
      type: 'other',
      name: 'Cruise Dubai → Muscat',
      origin: null,
    });
    expect(upgradeBackupRow('trips', { status: 'confirmed' }, 5)).toEqual({ status: 'active' });
    await db.close();
  }, 30_000); // starting an in-memory database is slow while other test files run
});

describe('migrations 9 and 10 (document types, IATA countries)', () => {
  it('turns National ID cards into Residence Cards and saved countries into the IATA form', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    const runner = {
      query: async (text: string, values: unknown[]) => {
        const r = await db.query<Record<string, unknown>>(text, values as never[]);
        return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
      },
      exec: async (sql: string) => void (await db.exec(sql)),
    };
    for (const m of MIGRATIONS.slice(0, 8)) typeof m === 'string' ? await db.exec(m) : await m(runner);
    await db.exec(`
      INSERT INTO clients (first_name, last_name, nationality, country) VALUES
        ('A', 'One', 'Pakistani', 'Pakistan'), ('B', 'Two', 'Antigua & Barbuda', 'UAE'), ('C', 'Three', 'Martian', NULL);
      INSERT INTO documents (client_id, type, issuing_country) VALUES (1, 'national_id', 'Turkey'), (1, 'other', NULL);
    `);
    for (const m of MIGRATIONS.slice(8)) typeof m === 'string' ? await db.exec(m) : await m(runner);
    const clients = await db.query('SELECT nationality, country FROM clients ORDER BY id');
    expect(clients.rows).toEqual([
      { nationality: 'PK - Pakistan', country: 'PK - Pakistan' },
      { nationality: 'AG - Antigua and Barbuda', country: 'AE - United Arab Emirates' },
      { nationality: 'Martian', country: null }, // not a country: left for the form to flag
    ]);
    const docs = await db.query('SELECT type, other_type, issuing_country FROM documents ORDER BY id');
    expect(docs.rows).toEqual([
      { type: 'residence_permit', other_type: null, issuing_country: 'TR - Türkiye' },
      { type: 'other', other_type: 'Other document', issuing_country: null },
    ]);
    await db.close();
  }, 30_000);
});
