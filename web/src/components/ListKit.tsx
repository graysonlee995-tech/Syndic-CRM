import { useState } from 'react';
import { Button, Group, Pagination, Table, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconFileSpreadsheet, IconSelector } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { TravellerOption } from '../types';

export const PAGE_SIZE = 25;

/**
 * List state (search, filter, sort, page). Full pages keep it in the URL so
 * links and the back button work; tables embedded in a profile keep it locally.
 */
export function useListState(urlBacked: boolean) {
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState(() => new URLSearchParams());
  const current = urlBacked ? params : local;

  function set(patch: Record<string, string | null>) {
    const next = new URLSearchParams(current);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    if (urlBacked) setParams(next, { replace: true });
    else setLocal(next);
  }

  const get = (key: string, fallback = '') => current.get(key) ?? fallback;
  return { get, set, page: Number(current.get('page') ?? 1) };
}

export type ListState = ReturnType<typeof useListState>;

/** A column header that sorts the list; clicking again flips the direction. */
export function SortTh({ list, sortKey, children, defaultDir = 'asc' }: { list: ListState; sortKey: string; children: React.ReactNode; defaultDir?: 'asc' | 'desc' }) {
  const active = list.get('sort') === sortKey;
  const dir = list.get('dir', 'asc');
  const Icon = !active ? IconSelector : dir === 'desc' ? IconChevronDown : IconChevronUp;
  return (
    <Table.Th>
      <UnstyledButton
        onClick={() => list.set({ sort: sortKey, dir: active ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir })}
        style={{ whiteSpace: 'nowrap', fontWeight: 'inherit', fontSize: 'inherit' }}
        aria-label={`Sort by ${typeof children === 'string' ? children : sortKey}`}
      >
        <Group gap={4} wrap="nowrap">
          {children}
          <Icon size={14} stroke={1.5} opacity={active ? 1 : 0.5} />
        </Group>
      </UnstyledButton>
    </Table.Th>
  );
}

/** The list's search parameters without paging, for "export everything matching". */
export function exportQuery(search: URLSearchParams): string {
  const all = new URLSearchParams(search);
  all.delete('page');
  all.delete('pageSize');
  return all.toString();
}

export function ListFooter({
  list,
  total,
  noun,
  exportHref,
}: {
  list: ListState;
  total: number | undefined;
  noun: string;
  /** Excel download of everything matching the current filters. */
  exportHref?: string;
}) {
  if (!total) return null;
  return (
    <Group justify="space-between">
      <Group gap="sm">
        <Text size="sm" c="dimmed">
          {total} {noun}
        </Text>
        {exportHref && (
          <Button
            component="a"
            href={exportHref}
            size="xs"
            variant="default"
            leftSection={<IconFileSpreadsheet size={14} />}
            title={`Download the ${total} ${noun} matching the current search and filters as an Excel file`}
          >
            Export to Excel
          </Button>
        )}
      </Group>
      {total > PAGE_SIZE && (
        <Pagination total={Math.ceil(total / PAGE_SIZE)} value={list.page} onChange={(p) => list.set({ page: String(p) })} />
      )}
    </Group>
  );
}

export function useCompanyOptions() {
  return useQuery({
    queryKey: ['companies', 'options'],
    queryFn: () => api<{ companies: { id: number; name: string }[] }>('/companies/options'),
    select: (d) => d.companies.map((c) => ({ value: String(c.id), label: c.name })),
  });
}

export function useTravellerOptions() {
  return useQuery({
    queryKey: ['clients', 'options'],
    queryFn: () => api<{ travellers: TravellerOption[] }>('/travellers/options'),
    select: (d) => d.travellers,
  });
}

/** Stops a click on a link or button inside a clickable table row from also opening the row. */
export const stop = (e: React.MouseEvent) => e.stopPropagation();
