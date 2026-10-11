import multer from 'multer';
import { config } from '../config.js';
import type { StoredFile } from '../db/repo.js';
import { detectMime, saveFile } from '../lib/files.js';
import { HttpError } from '../lib/http.js';

export const MAX_UPLOAD_BYTES = config.maxUploadMb * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/** Validates the uploaded file by content and stores it encrypted. */
export async function storeUpload(file: Express.Multer.File | undefined): Promise<StoredFile | null> {
  if (!file) return null;
  const mime = detectMime(file.buffer);
  if (!mime) throw new HttpError(400, 'Only PDF, JPG, PNG or WEBP files can be uploaded');
  // Browsers send the multipart file name as UTF-8 but busboy decodes it as latin1.
  const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200);
  return { file_name: await saveFile(file.buffer), original_name: originalName, mime_type: mime, size: file.size };
}
