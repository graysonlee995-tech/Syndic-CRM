import { insert, one, query, run, tx, value } from './index.js';
import { likePattern, type Bindable } from './repo.js';

/**
 * Quality assurance: a checklist answered once per trip. A trip needs it while it
 * is active and upcoming or ongoing; it passes when every active item has an
 * answer. Saving the trip or its bookings clears the answers (resetQc).
 */

export const QC_ANSWERS = ['verified', 'not_available', 'not_required'] as const;
export type QcAnswer = (typeof QC_ANSWERS)[number];

/** The standard checklist; also restored when a backup from before quality assurance is imported. */
export const DEFAULT_QC_ITEMS = [
  'Passport valid',
  'Visa requirement',
  'E arrival card',
  'KTN/Global Entry',
  'Frequent flyer number',
  'Seat assignment',
  'Meal request',
  'Special assistance',
  'Transportation request',
];

export interface QcItem {
  id: number;
  label: string;
  position: number;
  is_active: boolean;
}

export async function listQcItems(activeOnly = false): Promise<QcItem[]> {
  const rows = await query<Omit<QcItem, 'is_active'> & { is_active: number }>(
    `SELECT id, label, position, is_active FROM qc_items ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY position, id`,
  );
  return rows.map((r) => ({ ...r, is_active: Boolean(r.is_active) }));
}

/** Replaces the checklist with this list, in this order. Items left out are switched off, never deleted. */
export function saveQcItems(items: { id: number | null; label: string; is_active: boolean }[]): Promise<void> {
  return tx(async () => {
    const kept = new Set<number>();
    for (const [position, item] of items.entries()) {
      if (item.id) {
        await run('UPDATE qc_items SET label = ?, position = ?, is_active = ? WHERE id = ?', [item.label, position, item.is_active ? 1 : 0, item.id]);
        kept.add(item.id);
      } else {
        kept.add(await insert('INSERT INTO qc_items (label, position, is_active) VALUES (?, ?, ?)', [item.label, position, item.is_active ? 1 : 0]));
      }
    }
    for (const item of await listQcItems()) {
      if (!kept.has(item.id)) await run('UPDATE qc_items SET is_active = 0 WHERE id = ?', [item.id]);
    }
  });
}

export async function restoreDefaultQcItems(): Promise<void> {
  if (await value<number>('SELECT COUNT(*) FROM qc_items')) return;
  for (const [position, label] of DEFAULT_QC_ITEMS.entries()) {
    await run('INSERT INTO qc_items (label, position) VALUES (?, ?)', [label, position]);
  }
}

/** Trips that need a quality check: live, active, and not yet over. Needs @today. */
export const QC_DUE_SQL = `(t.deleted_at IS NULL AND t.status = 'active' AND COALESCE(t.return_date, t.departure_date) >= @today)`;

/** Active checklist items not yet answered for trip t. */
export const QC_MISSING_SQL = `(SELECT COUNT(*) FROM qc_items qi WHERE qi.is_active = 1
  AND NOT EXISTS (SELECT 1 FROM trip_qc q WHERE q.trip_id = t.id AND q.item_id = qi.id))`;

/**
 * The trip's quality status: 'passed' when every active item is answered,
 * 'missing' when not and the trip needs a check, null when it doesn't need one.
 * Needs @today.
 */
export const QC_STATUS_SQL = `CASE WHEN ${QC_MISSING_SQL} = 0 THEN 'passed' WHEN ${QC_DUE_SQL} THEN 'missing' ELSE NULL END`;

export interface TripQc {
  /** Whether the trip currently needs a quality check (active, upcoming or ongoing). */
  due: boolean;
  status: 'passed' | 'missing' | null;
  passed_by_name: string | null;
  passed_at: string | null;
  items: { id: number; label: string; answer: QcAnswer | null; answered_by_name: string | null; answered_at: string | null }[];
}

export async function getTripQc(tripId: number, today: string): Promise<TripQc> {
  const trip = await one<{ due: boolean; status: TripQc['status']; passed_by_name: string | null; passed_at: string | null }>(
    `SELECT ${QC_DUE_SQL} AS due, ${QC_STATUS_SQL} AS status, u.name AS passed_by_name, t.qc_passed_at AS passed_at
     FROM trips t LEFT JOIN users u ON u.id = t.qc_passed_by WHERE t.id = @id`,
    { id: tripId, today },
  );
  // Active items, plus switched-off ones this trip already has an answer for.
  const items = await query<TripQc['items'][number]>(
    `SELECT qi.id, qi.label, q.answer, u.name AS answered_by_name, q.answered_at
     FROM qc_items qi
     LEFT JOIN trip_qc q ON q.item_id = qi.id AND q.trip_id = ?
     LEFT JOIN users u ON u.id = q.answered_by
     WHERE qi.is_active = 1 OR q.answer IS NOT NULL
     ORDER BY qi.is_active DESC, qi.position, qi.id`,
    [tripId],
  );
  return {
    due: Boolean(trip?.due),
    status: trip?.status ?? null,
    passed_by_name: trip?.status === 'passed' ? trip.passed_by_name : null,
    passed_at: trip?.status === 'passed' ? trip.passed_at : null,
    items,
  };
}

/**
 * Saves answers (null clears one). When this completes the checklist, the user
 * is recorded as the one who passed it; returns whether it is now passed.
 */
export function saveTripQc(tripId: number, answers: { item_id: number; answer: QcAnswer | null }[], userId: number): Promise<{ passed: boolean; newlyPassed: boolean }> {
  return tx(async () => {
    for (const a of answers) {
      if (!a.answer) {
        await run('DELETE FROM trip_qc WHERE trip_id = ? AND item_id = ?', [tripId, a.item_id]);
        continue;
      }
      // Only a changed answer moves the "answered by".
      await run(
        `INSERT INTO trip_qc (trip_id, item_id, answer, answered_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (trip_id, item_id) DO UPDATE SET answer = excluded.answer, answered_by = excluded.answered_by, answered_at = now()
         WHERE trip_qc.answer IS DISTINCT FROM excluded.answer`,
        [tripId, a.item_id, a.answer, userId],
      );
    }
    const missing = await value<number>(`SELECT ${QC_MISSING_SQL} FROM trips t WHERE t.id = ?`, [tripId]);
    const wasPassed = Boolean(await value<string | null>('SELECT qc_passed_at FROM trips WHERE id = ?', [tripId]));
    if (missing === 0 && !wasPassed) {
      await run('UPDATE trips SET qc_passed_by = ?, qc_passed_at = now() WHERE id = ?', [userId, tripId]);
    } else if (missing > 0 && wasPassed) {
      await run('UPDATE trips SET qc_passed_by = NULL, qc_passed_at = NULL WHERE id = ?', [tripId]);
    }
    return { passed: missing === 0, newlyPassed: missing === 0 && !wasPassed };
  });
}

/** Clears the trip's checklist after a change to the trip or its bookings; true if there was anything to clear. */
export async function resetQc(tripId: number): Promise<boolean> {
  const answered = await value<number>('SELECT COUNT(*) FROM trip_qc WHERE trip_id = ?', [tripId]);
  if (!answered) return false;
  await run('DELETE FROM trip_qc WHERE trip_id = ?', [tripId]);
  await run('UPDATE trips SET qc_passed_by = NULL, qc_passed_at = NULL WHERE id = ?', [tripId]);
  return true;
}

export interface QcSearch {
  q: string;
  /** 'missing' and 'passed' cover trips that need a check; 'all' is both. */
  status: 'missing' | 'passed' | 'all';
  companyId: number | null;
  today: string;
  limit: number;
  offset: number;
}

export interface QcListRow {
  id: number;
  reference: string;
  name: string;
  company_id: number | null;
  company_name: string | null;
  departure_date: string;
  return_date: string | null;
  traveller_names: string | null;
  qc_status: 'passed' | 'missing';
  answered: number;
  total: number;
  passed_by_name: string | null;
  passed_at: string | null;
}

/** Trips that need a quality check, soonest first. */
export async function searchQc(s: QcSearch): Promise<{ rows: QcListRow[]; total: number }> {
  const where = [QC_DUE_SQL];
  const params: Record<string, Bindable> = { today: s.today };
  if (s.status !== 'all') where.push(`(${QC_MISSING_SQL} ${s.status === 'passed' ? '= 0' : '> 0'})`);
  if (s.companyId) {
    where.push('t.company_id = @companyId');
    params.companyId = s.companyId;
  }
  s.q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .forEach((word, i) => {
      params[`q${i}`] = likePattern(word);
      const like = (col: string) => `${col} ILIKE @q${i} ESCAPE '\\'`;
      where.push(`(${like('t.reference')} OR ${like('t.name')} OR ${like('co.name')}
        OR EXISTS (SELECT 1 FROM trip_travellers tt JOIN clients c ON c.id = tt.client_id
                   WHERE tt.trip_id = t.id AND (${like('c.first_name')} OR ${like('c.last_name')})))`);
    });
  const from = `FROM trips t LEFT JOIN companies co ON co.id = t.company_id WHERE ${where.join(' AND ')}`;
  const rows = await query<QcListRow>(
    `SELECT t.id, t.reference, t.name, t.company_id, co.name AS company_name, t.departure_date, t.return_date,
       (SELECT string_agg(c.first_name || ' ' || c.last_name, ', ' ORDER BY lower(c.last_name))
        FROM trip_travellers tt JOIN clients c ON c.id = tt.client_id WHERE tt.trip_id = t.id AND c.deleted_at IS NULL) AS traveller_names,
       CASE WHEN ${QC_MISSING_SQL} = 0 THEN 'passed' ELSE 'missing' END AS qc_status,
       (SELECT COUNT(*) FROM trip_qc q JOIN qc_items qi ON qi.id = q.item_id WHERE q.trip_id = t.id AND qi.is_active = 1) AS answered,
       (SELECT COUNT(*) FROM qc_items WHERE is_active = 1) AS total,
       (SELECT name FROM users WHERE id = t.qc_passed_by) AS passed_by_name, t.qc_passed_at AS passed_at
     ${from}
     ORDER BY t.departure_date, t.id
     LIMIT @limit OFFSET @offset`,
    { ...params, limit: s.limit, offset: s.offset },
  );
  const total = await value<number>(`SELECT COUNT(*) ${from}`, params);
  return { rows, total };
}
