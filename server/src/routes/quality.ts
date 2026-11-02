import { Router } from 'express';
import { z } from 'zod';
import { timezone } from '../db/repo.js';
import { listQcItems, searchQc } from '../db/quality.js';
import { todayInTz } from '../lib/dates.js';
import { optId, pagingSchema } from './schemas.js';

/** Quality assurance: trips that need a check, and the checklist itself. Answers are saved under /api/trips/:id/qc. */
export const qualityRouter = Router();

const listSchema = pagingSchema.extend({
  q: z.string().max(200).optional().default(''),
  status: z.enum(['missing', 'passed', 'all']).default('missing'),
  companyId: optId,
});

qualityRouter.get('/', async (req, res) => {
  const query = listSchema.parse(req.query);
  const { rows, total } = await searchQc({
    q: query.q,
    status: query.status,
    companyId: query.companyId,
    today: todayInTz(timezone()),
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  res.json({ trips: rows, total, page: query.page, pageSize: query.pageSize });
});

qualityRouter.get('/items', async (_req, res) => {
  res.json({ items: await listQcItems() });
});
