import { Alert, Anchor, Stack, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useMe } from './api';
import type { User } from './types';

/** Mirrors server/src/auth/permissions.ts: each section and the actions it has. */
export const ACTIONS = ['view', 'add', 'edit', 'delete', 'export'] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = { view: 'View', add: 'Add', edit: 'Edit', delete: 'Delete', export: 'Export' };

export const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', actions: ['view'] },
  { key: 'assistant', label: 'Assistant', actions: ['view'], note: 'Use the AI assistant (it can only do what this person may do)' },
  { key: 'quality', label: 'Quality Control', actions: ['view', 'edit'] },
  { key: 'trips', label: 'Trips', actions: ['view', 'add', 'edit', 'delete', 'export'] },
  { key: 'open_credits', label: 'Open Credits', actions: ['view', 'edit', 'delete', 'export'] },
  { key: 'companies', label: 'Companies', actions: ['view', 'add', 'edit', 'delete', 'export'] },
  { key: 'travellers', label: 'Travellers', actions: ['view', 'add', 'edit', 'delete', 'export'], note: 'Includes documents and frequent flyer numbers' },
  { key: 'trash', label: 'Trash', actions: ['view', 'edit', 'delete'], note: 'Edit = restore, Delete = delete permanently' },
  { key: 'audit', label: 'Audit log', actions: ['view'] },
  { key: 'employees', label: 'Employees', actions: ['view', 'edit'], note: 'Staff accounts only; never more rights than their own' },
  { key: 'settings', label: 'Settings', actions: ['view', 'edit'], note: 'Database backup and restore stay admin-only' },
] as const satisfies readonly { key: string; label: string; actions: readonly Action[]; note?: string }[];

export type Section = (typeof SECTIONS)[number]['key'];
export type Permissions = Partial<Record<Section, Action[]>>;

/** The standard staff rights (what staff could do before permissions existed). */
export const DEFAULT_STAFF_PERMISSIONS: Permissions = {
  dashboard: ['view'],
  assistant: ['view'],
  quality: ['view', 'edit'],
  trips: ['view', 'add', 'edit', 'export'],
  open_credits: ['view', 'edit', 'export'],
  companies: ['view', 'add', 'edit', 'export'],
  travellers: ['view', 'add', 'edit', 'export'],
};

export const VIEW_ONLY_PERMISSIONS: Permissions = Object.fromEntries(
  SECTIONS.filter((s) => !['trash', 'audit', 'employees', 'settings'].includes(s.key)).map((s) => [s.key, ['view']]),
);

export function can(user: User | null | undefined, section: Section, action: Action = 'view'): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(user.permissions?.[section]?.includes(action));
}

/** `can(section, action)` for the signed-in employee. */
export function useCan() {
  const { data: me } = useMe();
  return (section: Section, action: Action = 'view') => can(me, section, action);
}

/** Shows the page only with the permission; otherwise a short "no access" note. */
export function Allowed({ section, action = 'view', children }: { section: Section; action?: Action; children: React.ReactNode }) {
  const allowed = useCan()(section, action);
  if (allowed) return <>{children}</>;
  const label = SECTIONS.find((s) => s.key === section)?.label ?? section;
  return (
    <Stack maw={640}>
      <Title order={2}>{label}</Title>
      <Alert color="yellow" title="No access">
        You don't have permission to {action === 'view' ? 'open' : ACTION_LABELS[action].toLowerCase() + ' in'} {label}. Ask an
        administrator if you need it.{' '}
        <Anchor component={Link} to="/account">
          Your account
        </Anchor>
      </Alert>
    </Stack>
  );
}
