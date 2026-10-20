import { Badge, Group } from '@mantine/core';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 1985-03-15 -> 15 Mar 1985 (no timezone shifting). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** SQLite UTC timestamp -> local date and time. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function daysUntil(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
}

export function ExpiryBadge({ date, daysLeft }: { date: string | null; daysLeft?: number }) {
  if (!date) {
    return (
      <Badge color="gray" variant="light" style={{ minWidth: 'max-content' }}>
        No expiry
      </Badge>
    );
  }
  const days = daysLeft ?? daysUntil(date);
  let color = 'green';
  let label = `${days} days left`;
  if (days < 0) {
    color = 'red';
    label = `Expired ${-days} day${days === -1 ? '' : 's'} ago`;
  } else if (days === 0) {
    color = 'red';
    label = 'Expires today';
  } else if (days <= 7) {
    color = 'red';
  } else if (days <= 30) {
    color = 'orange';
  } else if (days <= 90) {
    color = 'yellow';
  } else {
    label = 'Valid';
  }
  return (
    <Badge color={color} variant={days <= 7 ? 'filled' : 'light'} style={{ minWidth: 'max-content' }}>
      {label}
    </Badge>
  );
}

/** 2026-10-09T14:30 (local, as typed) -> 9 Oct 2026, 14:30. Plain dates pass through formatDate. */
export function formatDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  const [date, time] = value.split('T');
  return time ? `${formatDate(date)}, ${time.slice(0, 5)}` : formatDate(date);
}

/** Company ids shown as C-0001, traveller ids as T-0001. */
export const companyCode = (id: number) => `C-${String(id).padStart(4, '0')}`;
export const travellerCode = (id: number) => `T-${String(id).padStart(4, '0')}`;

const PHASES: Record<string, { label: string; color: string }> = {
  upcoming: { label: 'Upcoming', color: 'blue' },
  ongoing: { label: 'Ongoing', color: 'mono' },
  past: { label: 'Completed', color: 'gray' },
  cancelled: { label: 'Cancelled', color: 'red' },
};

/** Where the trip is in time (or cancelled), plus whether it is still only planned. */
export function TripStatusBadge({ phase, status }: { phase: string; status: string }) {
  const p = PHASES[phase] ?? PHASES.upcoming;
  return (
    <Group gap={4} wrap="nowrap">
      <Badge color={p.color} variant="light" style={{ minWidth: 'max-content' }}>
        {p.label}
      </Badge>
      {status === 'planned' && phase !== 'cancelled' && (
        <Badge color="yellow" variant="outline" style={{ minWidth: 'max-content' }}>
          Planned
        </Badge>
      )}
    </Group>
  );
}

export const labelOf = (list: readonly { value: string; label: string }[], value: string | null | undefined) =>
  list.find((x) => x.value === value)?.label ?? value ?? '-';

export function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
