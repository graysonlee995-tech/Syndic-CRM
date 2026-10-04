import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeDueAlerts, reachedThreshold } from '../src/jobs/expiryAlerts.js';
import { computeDueBirthdays } from '../src/jobs/birthdays.js';
import { addDays, daysBetween, isIsoDate, nextBirthday, todayInTz } from '../src/lib/dates.js';
import { decrypt, detectMime, encrypt } from '../src/lib/files.js';
import { parseSearch } from '../src/lib/search.js';

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

describe('parseSearch', () => {
  it('splits input into lower case prefix terms', () => {
    expect(parseSearch('Ali kha').terms).toEqual(['ali', 'kha']);
    expect(parseSearch('ab" OR x%').terms).toEqual(['ab', 'or', 'x']);
    expect(parseSearch('Zoë').terms).toEqual(['zoe']);
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
