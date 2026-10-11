import { Router } from 'express';
import { z } from 'zod';
import { listActivity, TRASHABLE, type TrashKind } from '../db/repo.js';

/** Change history of one trip, company or traveller, shown on its profile. */
export const activityRouter = Router();

activityRouter.get('/', async (req, res) => {
  const { entity, id } = z
    .object({
      entity: z.enum(Object.keys(TRASHABLE) as [TrashKind, ...TrashKind[]]),
      id: z.coerce.number().int().positive(),
    })
    .parse(req.query);
  res.json({ entries: await listActivity(entity, id) });
});
