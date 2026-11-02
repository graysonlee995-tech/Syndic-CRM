import { Router } from 'express';
import { z } from 'zod';
import { audit, timezone } from '../db/repo.js';
import { CREDIT_STATUSES, deleteOpenCredit, getOpenCredit, moveCreditBack, searchOpenCredits, setOpenCreditStatus, type OpenCreditRow } from '../db/trips.js';
import { resetQc } from '../db/quality.js';
import { currentUser, requireRole } from '../auth/session.js';
import { todayInTz } from '../lib/dates.js';
import { HttpError, parseId } from '../lib/http.js';
import { EXPORT_LIMIT, exportFileName, sendWorkbook } from '../lib/excel.js';
import { creditStatusSchema, optId, pagingSchema } from './schemas.js';

/** Flights and trains taken off trips as unused credit, one per traveller. */
export const openCreditsRouter = Router();

const listSchema = pagingSchema.extend({
  q: z.string().max(200).optional().default(''),
  status: z.enum([...CREDIT_STATUSES, 'all']).default('open'),
  companyId: optId,
  travellerId: optId,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const searchFrom = (query: z.infer<typeof listSchema>, limit: number, offset: number) =>
  searchOpenCredits({
    q: query.q,
    status: query.status,
    companyId: query.companyId,
    travellerId: query.travellerId,
    tripId: null,
    limit,
    offset,
  });

openCreditsRouter.get('/', async (req, res) => {
  const query = listSchema.parse(req.query);
  const { rows, total } = await searchFrom(query, query.pageSize, (query.page - 1) * query.pageSize);
  res.json({ credits: rows, total, page: query.page, pageSize: query.pageSize });
});

openCreditsRouter.get('/export', async (req, res) => {
  const query = listSchema.parse(req.query);
  const { rows } = await searchFrom(query, EXPORT_LIMIT, 0);
  await audit(currentUser(req), 'open_credits_exported', 'open_credit', null, `${rows.length} credit(s); status ${query.status}`);
  await sendWorkbook(res, exportFileName('open-credits', todayInTz(timezone())), [
    {
      name: 'Open credits',
      columns: [
        { header: 'Company', key: 'company_name', width: 24 },
        { header: 'Traveller', key: 'traveller', width: 24 },
        { header: 'Trip reference', key: 'trip_reference', width: 16 },
        { header: 'Trip name', key: 'trip_name', width: 28 },
        { header: 'Type', key: 'type' },
        { header: 'Hotel', key: 'name', width: 22 },
        { header: 'Airline/Operator', key: 'airline', width: 18 },
        { header: 'Flight/Train No.', key: 'flight_number', width: 16 },
        { header: 'From', key: 'origin' },
        { header: 'To/City', key: 'destination' },
        { header: 'Departure/Check-in', key: 'departure_date', width: 18 },
        { header: 'Departure time', key: 'departure_time', width: 15 },
        { header: 'Arrival/Check-out', key: 'arrival_date', width: 18 },
        { header: 'Arrival time', key: 'arrival_time', width: 15 },
        { header: 'A/L PNR/Conf. No.', key: 'confirmation_number', width: 18 },
        { header: 'GDS PNR/TKT No.', key: 'gds_pnr', width: 18 },
        { header: 'Status', key: 'status' },
        { header: 'Notes', key: 'notes', width: 30 },
        { header: 'Credit since', key: 'created_at', width: 22 },
      ],
      rows: rows.map((r) => ({ ...r, traveller: `${r.first_name} ${r.last_name}` })),
    },
  ]);
});

async function requireCredit(rawId: unknown): Promise<OpenCreditRow> {
  const credit = await getOpenCredit(parseId(rawId));
  if (!credit) throw new HttpError(404, 'Open credit not found');
  return credit;
}

const describe = (c: OpenCreditRow) =>
  `${c.first_name} ${c.last_name}: ${[c.name, c.airline, c.flight_number].filter(Boolean).join(' ') || c.type} ${[c.origin, c.destination].filter(Boolean).join(' → ')} ${c.departure_date}`;

/** Marks the credit used, refunded or expired, or open again. */
openCreditsRouter.put('/:id/status', async (req, res) => {
  const credit = await requireCredit(req.params.id);
  const { status, notes } = creditStatusSchema.parse(req.body);
  await setOpenCreditStatus(credit, status, notes, currentUser(req).id);
  await audit(currentUser(req), 'trip_open_credit_updated', 'trip', credit.trip_id, `${describe(credit)} → ${status}`);
  res.json({ credit: await getOpenCredit(credit.id) });
});

/** Admins: put the row back on its trip (marked open credit by mistake); removes the credits of every traveller made from it. */
openCreditsRouter.post('/:id/move-back', requireRole('admin'), async (req, res) => {
  const credit = await requireCredit(req.params.id);
  const removed = await moveCreditBack(credit);
  await audit(currentUser(req), 'trip_open_credit_moved_back', 'trip', credit.trip_id, `${describe(credit)} (${removed} credit(s) removed)`);
  if (await resetQc(credit.trip_id)) await audit(currentUser(req), 'trip_qc_reset', 'trip', credit.trip_id, 'trip changed after the quality check');
  res.json({ ok: true, removed, trip_id: credit.trip_id });
});

openCreditsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const credit = await requireCredit(req.params.id);
  await deleteOpenCredit(credit);
  await audit(currentUser(req), 'trip_open_credit_removed', 'trip', credit.trip_id, describe(credit));
  res.json({ ok: true });
});
