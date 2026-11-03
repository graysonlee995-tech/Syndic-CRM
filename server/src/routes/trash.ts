import { Router } from 'express';
import { z } from 'zod';
import { audit, isTrashed, listTrash, purgeClient, restoreFromTrash, TRASHABLE, type TrashKind } from '../db/repo.js';
import { purgeCompany } from '../db/companies.js';
import { purgeTrip } from '../db/trips.js';
import { currentUser } from '../auth/session.js';
import { removeFiles } from '../lib/files.js';
import { HttpError, parseId } from '../lib/http.js';
import { requirePermission } from '../auth/permissions.js';

/** Trashed trips, companies and travellers (Trash permissions). */
export const trashRouter = Router();

const kindSchema = z.enum(Object.keys(TRASHABLE) as [TrashKind, ...TrashKind[]]);

async function trashedItem(params: { kind?: string; id?: string }) {
  const kind = kindSchema.parse(params.kind);
  const id = parseId(params.id);
  if (!(await isTrashed(kind, id))) throw new HttpError(404, 'Item is not in the trash');
  return { kind, id };
}

const PURGE = { trip: purgeTrip, client: purgeClient, company: purgeCompany };

trashRouter.get('/', requirePermission('trash', 'view'), async (_req, res) => {
  res.json({ items: await listTrash() });
});

trashRouter.post('/:kind/:id/restore', requirePermission('trash', 'edit'), async (req, res) => {
  const { kind, id } = await trashedItem(req.params);
  await restoreFromTrash(kind, id);
  await audit(currentUser(req), `${kind}_restored`, kind, id);
  res.json({ ok: true });
});

/**
 * Permanent. Trips take their bookings and files with them, travellers their
 * documents; a company's travellers and trips are kept, unlinked.
 */
trashRouter.delete('/:kind/:id', requirePermission('trash', 'delete'), async (req, res) => {
  const { kind, id } = await trashedItem(req.params);
  await removeFiles(await PURGE[kind](id));
  await audit(currentUser(req), `${kind}_deleted`, kind, id);
  res.json({ ok: true });
});
