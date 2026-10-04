import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  audit,
  countActiveAdmins,
  createUser,
  deleteUserSessions,
  getUserByEmail,
  getUserById,
  listUsers,
  toPublicUser,
  updateUser,
  type UserPatch,
} from '../db/repo.js';
import { currentUser } from '../auth/session.js';
import { HttpError, parseId } from '../lib/http.js';
import { BCRYPT_ROUNDS, passwordSchema } from './auth.js';

/** Employee accounts. Mounted behind requireRole('admin'). */
export const usersRouter = Router();

const role = z.enum(['admin', 'staff']);

usersRouter.get('/', async (_req, res) => {
  res.json({ users: (await listUsers()).map(toPublicUser) });
});

usersRouter.post('/', async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(100),
      email: z.string().trim().email().max(200),
      role,
      password: passwordSchema,
      receives_alerts: z.boolean().default(false),
    })
    .parse(req.body);
  if (await getUserByEmail(input.email)) throw new HttpError(409, 'An employee with this email already exists');
  const id = await createUser({
    name: input.name,
    email: input.email,
    role: input.role,
    receivesAlerts: input.receives_alerts,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
  });
  await audit(currentUser(req), 'user_created', 'user', id, `${input.email} (${input.role})`);
  res.status(201).json({ user: toPublicUser((await getUserById(id))!) });
});

usersRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const target = await getUserById(id);
  if (!target) throw new HttpError(404, 'Employee not found');
  const input = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      email: z.string().trim().email().max(200).optional(),
      role: role.optional(),
      is_active: z.boolean().optional(),
      receives_alerts: z.boolean().optional(),
      password: passwordSchema.optional(),
      reset_2fa: z.boolean().optional(),
      unlock: z.boolean().optional(),
    })
    .parse(req.body);

  const losesAdmin =
    target.role === 'admin' && target.is_active && (input.role === 'staff' || input.is_active === false);
  if (losesAdmin && (await countActiveAdmins()) <= 1) {
    throw new HttpError(400, 'There must always be at least one active administrator');
  }
  if (input.email && input.email.toLowerCase() !== target.email.toLowerCase() && (await getUserByEmail(input.email))) {
    throw new HttpError(409, 'An employee with this email already exists');
  }

  const patch: UserPatch = {
    name: input.name,
    email: input.email,
    role: input.role,
    is_active: input.is_active,
    receives_alerts: input.receives_alerts,
  };
  if (input.password) patch.password_hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  if (input.password || input.unlock) Object.assign(patch, { failed_logins: 0, locked_until: null });
  if (input.reset_2fa) Object.assign(patch, { totp_secret: null, totp_pending_secret: null });
  await updateUser(id, patch);

  // Signed-in sessions end when an account is disabled or its password is reset.
  if (input.is_active === false || input.password) {
    await deleteUserSessions(id, id === currentUser(req).id ? req.sessionId : undefined);
  }

  const changes = Object.keys(input).filter((k) => k !== 'password' && input[k as keyof typeof input] !== undefined);
  if (input.password) changes.push('password reset');
  await audit(currentUser(req), 'user_updated', 'user', id, changes.join(', '));
  res.json({ user: toPublicUser((await getUserById(id))!) });
});
