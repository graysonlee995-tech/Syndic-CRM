import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { getActiveSession, touchSession, toPublicUser, type PublicUser, type Role } from '../db/repo.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
      sessionId?: string;
    }
  }
}

export const SESSION_COOKIE = 'crm_sid';

export const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.isProd,
  sameSite: 'strict',
  path: '/',
};

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  const session = token ? await getActiveSession(token, config.sessionIdleHours) : undefined;
  if (!session || !session.user.is_active) {
    if (token) res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
    res.status(401).json({ error: 'Please sign in' });
    return;
  }
  // Avoid a write on every request; a minute of precision is plenty for idle timeouts.
  if (Date.now() - Date.parse(session.lastSeenAt.replace(' ', 'T') + 'Z') > 60_000) await touchSession(session.sessionId);
  req.user = toPublicUser(session.user);
  req.sessionId = session.sessionId;
  next();
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.role !== role) {
      res.status(403).json({ error: 'Only administrators can do this' });
      return;
    }
    next();
  };
}

/** The signed-in user; only valid on routes behind requireAuth. */
export function currentUser(req: Request): PublicUser {
  if (!req.user) throw new Error('requireAuth middleware missing');
  return req.user;
}
