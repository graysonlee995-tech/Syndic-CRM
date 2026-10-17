import Anthropic from '@anthropic-ai/sdk';
import { getSecret, setSecret } from '../db/repo.js';
import { decrypt, encrypt } from '../lib/files.js';

/**
 * The Anthropic API key for the assistant. An admin can save one in Settings
 * (stored encrypted with FILE_ENCRYPTION_KEY, never sent back to the browser);
 * otherwise ANTHROPIC_API_KEY from the server environment is used.
 */

const SECRET_NAME = 'anthropic_api_key';

export interface KeyStatus {
  configured: boolean;
  source: 'settings' | 'environment' | null;
  /** Last 4 characters, so admins can tell keys apart without seeing them. */
  last4: string | null;
}

async function savedKey(): Promise<string | null> {
  const stored = await getSecret(SECRET_NAME);
  if (!stored) return null;
  try {
    return decrypt(Buffer.from(stored, 'base64')).toString('utf8');
  } catch {
    // Saved with a different FILE_ENCRYPTION_KEY: treat as not set.
    console.error('[assistant] the saved API key cannot be decrypted with the current FILE_ENCRYPTION_KEY');
    return null;
  }
}

export async function assistantKey(): Promise<{ key: string; source: 'settings' | 'environment' } | null> {
  const saved = await savedKey();
  if (saved) return { key: saved, source: 'settings' };
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  // A malformed key (e.g. the shortened preview from the key list) would only fail later; ignore it.
  if (!env || keyFormatProblem(env)) return null;
  return { key: env, source: 'environment' };
}

export async function keyStatus(): Promise<KeyStatus> {
  const found = await assistantKey();
  return { configured: Boolean(found), source: found?.source ?? null, last4: found ? found.key.slice(-4) : null };
}

/** Problems with how a pasted key looks, before asking Anthropic. */
export function keyFormatProblem(key: string): string | null {
  if (!key.startsWith('sk-ant-')) return 'An Anthropic API key starts with "sk-ant-".';
  if (key.includes('...') || key.includes('…')) {
    return 'This is the shortened preview from the key list. Create a new key and use the Copy button in the window that shows the full key.';
  }
  if (/\s/.test(key)) return 'The key must not contain spaces or line breaks.';
  if (key.length < 40) return 'This key is too short. Copy the full key with the Copy button when you create it.';
  return null;
}

/** Saves a key after Anthropic confirms it works; throws an Error with a readable message otherwise. */
export async function saveAssistantKey(key: string, model: string): Promise<void> {
  const problem = keyFormatProblem(key);
  if (problem) throw new Error(problem);
  try {
    // A free request that only succeeds with a working key.
    await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000 }).models.retrieve(model);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept this key. Check that you copied the whole key.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('This key is not allowed to use the assistant model. Check your Anthropic workspace.');
    if (err instanceof Anthropic.NotFoundError) throw new Error(`The model ${model} is not available to this key.`);
    if (err instanceof Anthropic.APIError) throw new Error(`Anthropic could not check the key right now (${err.status}). Try again shortly.`);
    throw new Error('Could not reach Anthropic to check the key. Check the internet connection and try again.');
  }
  await setSecret(SECRET_NAME, encrypt(Buffer.from(key, 'utf8')).toString('base64'));
}

export async function removeAssistantKey(): Promise<void> {
  await setSecret(SECRET_NAME, null);
}
