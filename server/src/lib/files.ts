import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { one, run } from '../db/index.js';

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

function checkName(name: string): string {
  if (!/^[a-f0-9-]{36}\.bin$/.test(name)) throw new Error('Invalid stored file name');
  return name;
}

// ---------------------------------------------------------------- storage backends
// Files are always encrypted before they are stored, so the storage provider
// only ever holds ciphertext.

interface Storage {
  put(name: string, data: Buffer): Promise<void>;
  get(name: string): Promise<Buffer>;
  remove(name: string): Promise<void>;
}

const diskStorage = (): Storage => {
  const dir = path.join(config.dataDir, 'files');
  return {
    async put(name, data) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, name), data);
    },
    get: (name) => fs.promises.readFile(path.join(dir, name)),
    remove: (name) => fs.promises.rm(path.join(dir, name), { force: true }),
  };
};

/** Private Supabase Storage bucket, used with the service role key (server side only). */
const supabaseStorage = (): Storage => {
  const { url, serviceRoleKey, bucket } = config.supabase;
  const headers = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
  const objectUrl = (name: string) => `${url}/storage/v1/object/${bucket}/${name}`;
  let bucketReady: Promise<void> | null = null;

  async function fail(res: Response, what: string): Promise<never> {
    throw new Error(`Supabase Storage ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  /** Creates the private bucket the first time it is needed. */
  function ensureBucket(): Promise<void> {
    bucketReady ??= (async () => {
      const res = await fetch(`${url}/storage/v1/bucket/${bucket}`, { headers });
      if (res.ok) return;
      const created = await fetch(`${url}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: false }),
      });
      if (!created.ok && created.status !== 409) await fail(created, 'bucket creation');
    })().catch((err) => {
      bucketReady = null;
      throw err;
    });
    return bucketReady;
  }

  return {
    async put(name, data) {
      await ensureBucket();
      const res = await fetch(objectUrl(name), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' },
        body: new Uint8Array(data),
      });
      if (!res.ok) await fail(res, 'upload');
    },
    async get(name) {
      const res = await fetch(objectUrl(name), { headers });
      if (!res.ok) await fail(res, 'download');
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(name) {
      const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [name] }),
      });
      if (!res.ok && res.status !== 404) await fail(res, 'delete');
    },
  };
};

/** Encrypted files in the database's stored_files table (base64 over the wire keeps both drivers alike). */
const databaseStorage = (): Storage => ({
  async put(name, data) {
    await run("INSERT INTO stored_files (name, data) VALUES (?, decode(?, 'base64'))", [name, data.toString('base64')]);
  },
  async get(name) {
    const row = await one<{ data: string }>("SELECT encode(data, 'base64') AS data FROM stored_files WHERE name = ?", [name]);
    if (!row) throw new Error(`Stored file ${name} not found`);
    return Buffer.from(row.data.replace(/\s/g, ''), 'base64');
  },
  async remove(name) {
    await run('DELETE FROM stored_files WHERE name = ?', [name]);
  },
});

export const usingSupabaseStorage = Boolean(config.supabase.url && config.supabase.serviceRoleKey);
/** Files live outside this machine (Supabase Storage or the Supabase database). */
export const usingRemoteStorage = usingSupabaseStorage || Boolean(config.databaseUrl);
const storage: Storage = usingSupabaseStorage
  ? supabaseStorage()
  : config.databaseUrl
    ? databaseStorage()
    : diskStorage();

/** Encrypts and stores a file; returns the stored file name. */
export async function saveFile(plain: Buffer): Promise<string> {
  const name = `${crypto.randomUUID()}.bin`;
  await storage.put(name, encrypt(plain));
  return name;
}

/** Stores an already-encrypted file under its existing name (used when copying data between servers). */
export async function putEncryptedFile(name: string, encrypted: Buffer): Promise<void> {
  await storage.put(checkName(name), encrypted);
}

export async function readFile(name: string): Promise<Buffer> {
  return decrypt(await storage.get(checkName(name)));
}

/** Removes a stored file. Failures are logged, not thrown: the record is already gone. */
export async function removeFile(name: string | null | undefined): Promise<void> {
  if (!name) return;
  try {
    await storage.remove(checkName(name));
  } catch (err) {
    console.error(`[files] could not remove ${name}:`, err);
  }
}

export async function removeFiles(names: (string | null | undefined)[]): Promise<void> {
  await Promise.all(names.map(removeFile));
}
