import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { one, q } from '../db/index.js';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(plain: Buffer, key = config.fileKey): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer, key = config.fileKey): Buffer {
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
}

export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/** Identify the file from its first bytes rather than trusting the browser. */
export function detectMime(buf: Buffer): AllowedMime | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// ---- Storage: a table in the database (default), a private Supabase Storage bucket, or DATA_DIR/files locally.
// Files are encrypted before they leave the server, so the bucket only ever holds ciphertext.

const supabase = config.fileStorage === 'supabase'
  ? createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

const filesDir = () => path.join(config.dataDir, 'files');

function checkName(name: string): string {
  if (!/^[a-f0-9-]{36}\.bin$/.test(name)) throw new Error('Invalid stored file name');
  return name;
}

let bucketReady: Promise<void> | null = null;

/** Creates the private bucket on first use if it does not exist yet. */
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const { data } = await supabase!.storage.getBucket(config.storageBucket);
    if (data) return;
    const { error } = await supabase!.storage.createBucket(config.storageBucket, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  })().catch((err) => {
    bucketReady = null;
    throw err;
  });
  return bucketReady;
}

/** Encrypts and stores a file; returns the stored file name. */
export async function saveFile(plain: Buffer): Promise<string> {
  const name = `${crypto.randomUUID()}.bin`;
  const body = encrypt(plain);
  if (supabase) {
    await ensureBucket();
    const { error } = await supabase.storage
      .from(config.storageBucket)
      .upload(name, body, { contentType: 'application/octet-stream', upsert: false });
    if (error) throw new Error(`File upload to storage failed: ${error.message}`);
  } else if (config.fileStorage === 'db') {
    await q('INSERT INTO files (name, data) VALUES ($1, $2)', [checkName(name), body]);
  } else {
    fs.mkdirSync(filesDir(), { recursive: true });
    fs.writeFileSync(path.join(filesDir(), checkName(name)), body);
  }
  return name;
}

export async function readFile(name: string): Promise<Buffer> {
  checkName(name);
  if (supabase) {
    const { data, error } = await supabase.storage.from(config.storageBucket).download(name);
    if (error || !data) throw new Error(`File download from storage failed: ${error?.message ?? 'no data'}`);
    return decrypt(Buffer.from(await data.arrayBuffer()));
  }
  if (config.fileStorage === 'db') {
    const row = await one<{ data: Buffer }>('SELECT data FROM files WHERE name = $1', [name]);
    if (!row) throw new Error(`Stored file ${name} not found`);
    return decrypt(row.data);
  }
  return decrypt(fs.readFileSync(path.join(filesDir(), name)));
}

export async function removeFile(name: string | null | undefined): Promise<void> {
  if (!name) return;
  checkName(name);
  if (supabase) {
    const { error } = await supabase.storage.from(config.storageBucket).remove([name]);
    if (error) console.error(`[files] could not remove ${name}: ${error.message}`);
    return;
  }
  if (config.fileStorage === 'db') {
    await q('DELETE FROM files WHERE name = $1', [name]);
    return;
  }
  fs.rmSync(path.join(filesDir(), name), { force: true });
}
