import { getSecret, setSecret } from '../db/repo.js';
import { decrypt, encrypt } from './files.js';

/**
 * Secrets saved from the Settings page (API keys, the SMTP password), encrypted
 * with FILE_ENCRYPTION_KEY like uploaded documents. They are never sent back
 * to the browser.
 */

export async function readSecret(name: string): Promise<string | null> {
  const stored = await getSecret(name);
  if (!stored) return null;
  try {
    return decrypt(Buffer.from(stored, 'base64')).toString('utf8');
  } catch {
    // Saved with a different FILE_ENCRYPTION_KEY: treat as not set.
    console.error(`[secrets] "${name}" cannot be decrypted with the current FILE_ENCRYPTION_KEY`);
    return null;
  }
}

export async function writeSecret(name: string, value: string | null): Promise<void> {
  await setSecret(name, value === null ? null : encrypt(Buffer.from(value, 'utf8')).toString('base64'));
}
