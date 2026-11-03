import { Router } from 'express';
import { audit, deleteDocument, getDocument, updateDocument } from '../db/repo.js';
import { currentUser } from '../auth/session.js';
import { readFile, removeFile } from '../lib/files.js';
import { contentDisposition, HttpError, parseId } from '../lib/http.js';
import { documentSchema } from './schemas.js';
import { storeUpload, upload } from './uploads.js';
import { requirePermission } from '../auth/permissions.js';

export const documentsRouter = Router();

documentsRouter.put('/:id', requirePermission('travellers', 'edit'), upload.single('file'), async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getDocument(id);
  if (!before) throw new HttpError(404, 'Document not found');
  const input = documentSchema.parse(req.body);
  const file = await storeUpload(req.file);
  try {
    await updateDocument(id, input, file, currentUser(req).id);
  } catch (err) {
    await removeFile(file?.file_name);
    throw err;
  }
  if (file) await removeFile(before.file_name);
  await audit(currentUser(req), file ? 'document_replaced' : 'document_updated', 'document', id);
  res.json({ document: await getDocument(id) });
});

documentsRouter.get('/:id/file', requirePermission('travellers', 'view'), async (req, res) => {
  const id = parseId(req.params.id);
  const doc = await getDocument(id);
  if (!doc?.file_name) throw new HttpError(404, 'No file uploaded for this document');
  const download = req.query.download === '1';
  await audit(currentUser(req), download ? 'file_downloaded' : 'file_viewed', 'document', id);
  const body = await readFile(doc.file_name);
  const name = doc.original_name || `document-${id}`;
  res.set({
    'Content-Type': doc.mime_type ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', name),
    'Cache-Control': 'private, no-store',
  });
  res.send(body);
});

documentsRouter.delete('/:id', requirePermission('travellers', 'delete'), async (req, res) => {
  const id = parseId(req.params.id);
  const doc = await getDocument(id);
  if (!doc) throw new HttpError(404, 'Document not found');
  await deleteDocument(id);
  await removeFile(doc.file_name);
  await audit(currentUser(req), 'document_deleted', 'document', id, `${doc.type} of client #${doc.client_id}`);
  res.json({ ok: true });
});
