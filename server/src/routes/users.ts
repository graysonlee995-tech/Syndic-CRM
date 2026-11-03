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
import type { Request } from 'express';
import { currentUser } from '../auth/session.js';
import { canGrant, permissionsSchema, type Permissions } from '../auth/permissions.js';
import { HttpError, parseId } from '../lib/http.js';
import { BCRYPT_ROUNDS, passwordSchema } from './auth.js';
import { requirePermission } from '../auth/permissions.js';

/** Employee accounts (Employees permissions; only admins manage admins). */
export const usersRouter = Router();

const role = z.enum(['admin', 'staff']);

/**
 * Staff with the Employees "edit" permission manage staff accounts only: they
 * can't touch admins or make anyone an admin, can't change their own role or
 * permissions, and can't give anyone more than they have themselves.
 */
function assertMayManage(req: Request, target: { id: number; role: string } | null, input: { role?: string; permissions?: Permissions }) {
  const me = currentUser(req);
  if (me.role === 'admin') return;
  if (target?.role === 'admin' || input.role === 'admin') throw new HttpError(403, 'Only an administrator can create or change administrator accounts.');
  if (target?.id === me.id && (input.role !== undefined || input.permissions !== undefined)) {
    throw new HttpError(403, 'You cannot change your own role or permissions.');
  }
  if (input.permissions && !canGrant(me, input.permissions)) {
    throw new HttpError(403, 'You can only give permissions that you have yourself.');
  }
}

usersRouter.get('/', requirePermission('employees', 'view'), async (_req, res) => {
  res.json({ users: (await listUsers()).map(toPublicUser) });
});

usersRouter.post('/', requirePermission('employees', 'edit'), async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(100),
      email: z.string().trim().email().max(200),
      role,
      password: passwordSchema,
      receives_alerts: z.boolean().default(false),
      /** Staff only; left out = the standard staff rights. */
      permissions: permissionsSchema.optional(),
    })
    .parse(req.body);
  assertMayManage(req, null, input);
  if (await getUserByEmail(input.email)) throw new HttpError(409, 'An employee with this email already exists');
  const id = await createUser({
    name: input.name,
    email: input.email,
    role: input.role,
    receivesAlerts: input.receives_alerts,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    permissions: input.role === 'staff' ? input.permissions : undefined,
  });
  await audit(currentUser(req), 'user_created', 'user', id, `${input.email} (${input.role})`);
  res.status(201).json({ user: toPublicUser((await getUserById(id))!) });
});

usersRouter.put('/:id', requirePermission('employees', 'edit'), async (req, res) => {
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
      permissions: permissionsSchema.optional(),
    })
    .parse(req.body);
  assertMayManage(req, target, input);

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
    permissions: input.permissions ? JSON.stringify(input.permissions) : undefined,
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
