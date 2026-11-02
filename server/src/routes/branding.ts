import { Router } from 'express';
import { z } from 'zod';
import { audit, getAsset, setAsset } from '../db/repo.js';
import { currentUser } from '../auth/session.js';
import { detectMime } from '../lib/files.js';
import { HttpError } from '../lib/http.js';

/** Largest logo accepted (it is stored in the database and sent with every page). */
const MAX_LOGO_BYTES = 512 * 1024;

/** The agency logo, shown on the sign-in page (so it needs no sign-in), the header and travel agenda PDFs. */
export const logoRouter = Router();

logoRouter.get('/', async (_req, res) => {
  const logo = await getAsset('logo');
  if (!logo) throw new HttpError(404, 'No logo uploaded');
  res.set({ 'Content-Type': logo.mime, 'Cache-Control': 'no-cache', 'Content-Disposition': 'inline' });
  res.send(Buffer.from(logo.data, 'base64'));
});

/** Admin only (mounted under /api/admin). PNG, JPEG or WebP as a data: URL; SVG is refused because it can carry scripts. */
export const adminLogoRouter = Router();

adminLogoRouter.put('/', async (req, res) => {
  const { dataUrl } = z.object({ dataUrl: z.string().max(1_000_000) }).parse(req.body);
  const match = /^data:[^;,]*;base64,(.+)$/.exec(dataUrl);
  const bytes = match ? Buffer.from(match[1], 'base64') : null;
  const mime = bytes ? detectMime(bytes) : null;
  if (!bytes || !mime || mime === 'application/pdf') throw new HttpError(400, 'Choose a PNG, JPEG or WebP image.');
  if (bytes.length > MAX_LOGO_BYTES) throw new HttpError(400, 'The logo must be 512 KB or smaller.');
  const updated_at = new Date().toISOString();
  await setAsset('logo', { mime, data: bytes.toString('base64'), updated_at });
  await audit(currentUser(req), 'settings_updated', 'settings', null, `logo uploaded (${Math.ceil(bytes.length / 1024)} KB)`);
  res.json({ logoVersion: updated_at });
});

adminLogoRouter.delete('/', async (req, res) => {
  await setAsset('logo', null);
  await audit(currentUser(req), 'settings_updated', 'settings', null, 'logo removed');
  res.json({ logoVersion: null });
});
