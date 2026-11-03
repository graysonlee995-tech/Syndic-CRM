import { Router } from 'express';
import { z } from 'zod';
import { listActivity, TRASHABLE, type TrashKind } from '../db/repo.js';
import { can, permissionMessage, type Section } from '../auth/permissions.js';
import { HttpError } from '../lib/http.js';

/** Change history of one trip, company or traveller, shown on its profile. */
export const activityRouter = Router();

/** Seeing a record's history needs the right to view that record. */
const SECTION_OF: Record<TrashKind, Section> = { trip: 'trips', company: 'companies', client: 'travellers' };

activityRouter.get('/', async (req, res) => {
  const { entity, id } = z
    .object({
      entity: z.enum(Object.keys(TRASHABLE) as [TrashKind, ...TrashKind[]]),
      id: z.coerce.number().int().positive(),
    })
    .parse(req.query);
  if (!can(req.user, SECTION_OF[entity], 'view')) throw new HttpError(403, permissionMessage(SECTION_OF[entity], 'view'));
  res.json({ entries: await listActivity(entity, id) });
});
