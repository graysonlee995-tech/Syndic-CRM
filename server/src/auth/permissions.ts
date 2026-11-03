import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/**
 * What a staff member may do, per section of the CRM. Admins can always do
 * everything. Stored on the user as JSON; anything missing means "not allowed".
 */

export const ACTIONS = ['view', 'add', 'edit', 'delete', 'export'] as const;
export type Action = (typeof ACTIONS)[number];

/** Each section and the actions that mean something for it. */
export const SECTIONS = {
  dashboard: ['view'],
  assistant: ['view'],
  quality: ['view', 'edit'],
  trips: ['view', 'add', 'edit', 'delete', 'export'],
  open_credits: ['view', 'edit', 'delete', 'export'],
  companies: ['view', 'add', 'edit', 'delete', 'export'],
  travellers: ['view', 'add', 'edit', 'delete', 'export'],
  trash: ['view', 'edit', 'delete'],
  audit: ['view'],
  employees: ['view', 'edit'],
  settings: ['view', 'edit'],
} as const satisfies Record<string, readonly Action[]>;
export type Section = keyof typeof SECTIONS;
export const SECTION_KEYS = Object.keys(SECTIONS) as Section[];

export type Permissions = Partial<Record<Section, Action[]>>;

/** What staff could do before permissions existed: view, add and edit the main sections and export lists; no deleting, no admin pages. */
export const DEFAULT_STAFF_PERMISSIONS: Permissions = {
  dashboard: ['view'],
  assistant: ['view'],
  quality: ['view', 'edit'],
  trips: ['view', 'add', 'edit', 'export'],
  open_credits: ['view', 'edit', 'export'],
  companies: ['view', 'add', 'edit', 'export'],
  travellers: ['view', 'add', 'edit', 'export'],
};

export const ALL_PERMISSIONS: Permissions = Object.fromEntries(SECTION_KEYS.map((s) => [s, [...SECTIONS[s]]]));

/** Keeps only known sections and the actions they have; "view" comes with any other action. */
export function cleanPermissions(input: unknown): Permissions {
  const out: Permissions = {};
  if (!input || typeof input !== 'object') return out;
  for (const section of SECTION_KEYS) {
    const raw = (input as Record<string, unknown>)[section];
    if (!Array.isArray(raw)) continue;
    const allowed = SECTIONS[section] as readonly Action[];
    const actions = allowed.filter((a) => raw.includes(a));
    if (actions.length && !actions.includes('view')) actions.unshift('view');
    if (actions.length) out[section] = actions;
  }
  return out;
}

export const permissionsSchema = z.record(z.array(z.enum(ACTIONS))).transform(cleanPermissions);

/** A user's permissions as stored (JSON text, or null for accounts from before permissions: the old staff rights). */
export function effectivePermissions(role: 'admin' | 'staff', stored: string | null): Permissions {
  if (role === 'admin') return ALL_PERMISSIONS;
  if (stored === null) return DEFAULT_STAFF_PERMISSIONS;
  try {
    return cleanPermissions(JSON.parse(stored));
  } catch {
    return {};
  }
}

export function can(user: { role: string; permissions: Permissions } | undefined, section: Section, action: Action): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(user.permissions[section]?.includes(action));
}

const ACTION_WORDS: Record<Action, string> = { view: 'view', add: 'add to', edit: 'change', delete: 'delete from', export: 'export' };
const SECTION_WORDS: Record<Section, string> = {
  dashboard: 'the Dashboard',
  assistant: 'the Assistant',
  quality: 'Quality Control',
  trips: 'Trips',
  open_credits: 'Open Credits',
  companies: 'Companies',
  travellers: 'Travellers',
  trash: 'the Trash',
  audit: 'the Audit log',
  employees: 'Employees',
  settings: 'Settings',
};

export const permissionMessage = (section: Section, action: Action) =>
  `You don't have permission to ${ACTION_WORDS[action]} ${SECTION_WORDS[section]}. Ask an administrator.`;

/** Route guard: the signed-in user needs this permission. */
export function requirePermission(section: Section, action: Action) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!can(req.user, section, action)) {
      res.status(403).json({ error: permissionMessage(section, action) });
      return;
    }
    next();
  };
}

/** Route guard: any one of these permissions is enough (e.g. pickers used on several pages). */
export function requireAnyPermission(...needs: [Section, Action][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!needs.some(([s, a]) => can(req.user, s, a))) {
      res.status(403).json({ error: permissionMessage(needs[0][0], needs[0][1]) });
      return;
    }
    next();
  };
}

/** Whether `granter` may give these permissions: never more than they have themselves. */
export function canGrant(granter: { role: string; permissions: Permissions }, wanted: Permissions): boolean {
  if (granter.role === 'admin') return true;
  return SECTION_KEYS.every((s) => (wanted[s] ?? []).every((a) => can(granter, s, a)));
}
