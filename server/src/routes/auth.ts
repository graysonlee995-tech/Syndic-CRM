import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  audit,
  createSession,
  deleteSessionByToken,
  deleteUserSessions,
  getUserByEmail,
  getUserById,
  toPublicUser,
  updateUser,
  type UserRow,
} from '../db/repo.js';
import { currentUser, requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../auth/session.js';
import { HttpError } from '../lib/http.js';

export const BCRYPT_ROUNDS = 12;
export const MIN_PASSWORD_LENGTH = 10;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts from this network. Try again in 15 minutes.' },
});

async function registerFailure(user: UserRow): Promise<void> {
  const failures = user.failed_logins + 1;
  if (failures >= MAX_FAILED_LOGINS) {
    await updateUser(user.id, {
      failed_logins: 0,
      locked_until: new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(),
    });
    await audit(user, 'account_locked', 'user', user.id);
  } else {
    await updateUser(user.id, { failed_logins: failures });
  }
}

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
  totp: z.string().trim().max(10).optional(),
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password, totp } = loginSchema.parse(req.body);
  const user = await getUserByEmail(email);

  if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
    const minutes = Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60_000);
    throw new HttpError(423, `Account locked after too many failed attempts. Try again in ${minutes} minute(s) or ask an administrator to reset it.`);
  }

  const passwordOk = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !passwordOk || !user.is_active) {
    if (user && !passwordOk) await registerFailure(user);
    await audit(null, 'login_failed', 'user', user?.id ?? null, email);
    throw new HttpError(401, 'Invalid email or password');
  }

  if (user.totp_secret) {
    if (!totp) {
      res.json({ needTotp: true });
      return;
    }
    if (!authenticator.verify({ token: totp.replace(/\s/g, ''), secret: user.totp_secret })) {
      await registerFailure(user);
      throw new HttpError(401, 'Invalid authentication code');
    }
  }

  await updateUser(user.id, { failed_logins: 0, locked_until: null, last_login_at: new Date().toISOString() });
  const token = await createSession(user.id);
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions);
  await audit(user, 'login', 'user', user.id);
  res.json({ user: toPublicUser((await getUserById(user.id))!) });
});

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) await deleteSessionByToken(token);
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: currentUser(req) });
});

authRouter.post('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = z
    .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
    .parse(req.body);
  const user = (await getUserById(currentUser(req).id))!;
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  await updateUser(user.id, { password_hash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
  await deleteUserSessions(user.id, req.sessionId);
  await audit(user, 'password_changed', 'user', user.id);
  res.json({ ok: true });
});

// ---- Two-factor authentication (authenticator app)

authRouter.post('/2fa/setup', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const secret = authenticator.generateSecret();
  await updateUser(user.id, { totp_pending_secret: secret });
  const uri = authenticator.keyuri(user.email, 'Travel CRM', secret);
  res.json({ secret, qr: await QRCode.toDataURL(uri) });
});

authRouter.post('/2fa/enable', requireAuth, async (req, res) => {
  const { code } = z.object({ code: z.string().trim().min(6).max(10) }).parse(req.body);
  const user = (await getUserById(currentUser(req).id))!;
  if (!user.totp_pending_secret) throw new HttpError(400, 'Start the set-up first');
  if (!authenticator.verify({ token: code.replace(/\s/g, ''), secret: user.totp_pending_secret })) {
    throw new HttpError(400, 'That code is not correct. Check the time on your phone and try again.');
  }
  await updateUser(user.id, { totp_secret: user.totp_pending_secret, totp_pending_secret: null });
  await audit(user, '2fa_enabled', 'user', user.id);
  res.json({ user: toPublicUser((await getUserById(user.id))!) });
});

authRouter.post('/2fa/disable', requireAuth, async (req, res) => {
  const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
  const user = (await getUserById(currentUser(req).id))!;
  if (!(await bcrypt.compare(password, user.password_hash))) throw new HttpError(400, 'Password is incorrect');
  await updateUser(user.id, { totp_secret: null, totp_pending_secret: null });
  await audit(user, '2fa_disabled', 'user', user.id);
  res.json({ user: toPublicUser((await getUserById(user.id))!) });
});
