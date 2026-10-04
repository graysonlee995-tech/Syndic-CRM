/**
 * Creates the first administrator from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD
 * (and optional INITIAL_ADMIN_NAME) when the database has no employees yet.
 * Needed on hosts without a console, such as Vercel. Once an account exists this
 * does nothing, so the password variable can be removed after the first sign in.
 */
import bcrypt from 'bcryptjs';
import { q } from '../db/index.js';
import { createUser } from '../db/repo.js';
import { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH } from '../routes/auth.js';

export async function createFirstAdmin(): Promise<void> {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !password) return;
  const [{ n }] = await q<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
  if (n > 0) return;
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`[setup] INITIAL_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters; no admin created.`);
    return;
  }
  const name = process.env.INITIAL_ADMIN_NAME?.trim() || 'Administrator';
  await createUser({ name, email, role: 'admin', passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), receivesAlerts: true });
  console.log(`[setup] Created the first admin account for ${email}. You can now remove INITIAL_ADMIN_PASSWORD.`);
}
