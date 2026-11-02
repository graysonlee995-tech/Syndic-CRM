import { useEffect, useState } from 'react';
import { ActionIcon, Button, Card, Group, Loader, Stack, Switch, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconShieldCheck, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import type { QcItem } from '../types';

type Row = { key: number; id: number | null; label: string; is_active: boolean };
let nextKey = 1;

/**
 * The quality checklist: add, rename, reorder or switch off items. Every item is
 * answered Verified / Not available / Not required on each trip. Saved items are
 * switched off rather than deleted, so answers on trips are kept.
 */
export function QcItemsCard() {
  const { data } = useQuery({ queryKey: ['quality', 'items'], queryFn: () => api<{ items: QcItem[] }>('/quality/items') });
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (data) setRows(data.items.map((i) => ({ key: nextKey++, id: i.id, label: i.label, is_active: i.is_active })));
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api<{ items: QcItem[] }>('/admin/qc-items', {
        method: 'PUT',
        body: { items: rows.filter((r) => r.label.trim()).map(({ id, label, is_active }) => ({ id, label: label.trim(), is_active })) },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      queryClient.invalidateQueries({ queryKey: ['trip'] });
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      notifySuccess('Quality checklist saved');
    },
    onError: notifyError,
  });

  const set = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (index: number, by: number) =>
    setRows((all) => {
      const next = [...all];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row);
      return next;
    });

  return (
    <Card withBorder>
      <Stack>
        <Group gap="xs">
          <IconShieldCheck size={18} />
          <Title order={5}>Quality check items</Title>
        </Group>
        <Text size="sm" c="dimmed">
          The checklist on every upcoming and ongoing trip. Each item is answered Verified, Not available or Not required; a
          trip passes when all switched-on items are answered. Switching an item off keeps the answers already given.
        </Text>
        {!data ? (
          <Loader size="sm" />
        ) : (
          <Stack gap={6}>
            {rows.map((r, i) => (
              <Group key={r.key} gap="xs" wrap="nowrap">
                <Text size="sm" c="dimmed" w={22} ta="right">
                  {i + 1}.
                </Text>
                <TextInput
                  aria-label="Item"
                  placeholder="e.g. Travel insurance"
                  value={r.label}
                  onChange={(e) => {
                    const { value } = e.currentTarget;
                    set(r.key, { label: value });
                  }}
                  style={{ flex: 1 }}
                  styles={r.is_active ? undefined : { input: { textDecoration: 'line-through', opacity: 0.6 } }}
                />
                <Switch aria-label="Asked on trips" label="On" checked={r.is_active} onChange={(e) => set(r.key, { is_active: e.currentTarget.checked })} />
                <ActionIcon variant="subtle" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <IconArrowUp size={14} />
                </ActionIcon>
                <ActionIcon variant="subtle" size="sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <IconArrowDown size={14} />
                </ActionIcon>
                {r.id === null && (
                  <Tooltip label="Remove (not saved yet)">
                    <ActionIcon variant="subtle" color="red" size="sm" aria-label="Remove" onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
            ))}
          </Stack>
        )}
        <Group>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setRows((all) => [...all, { key: nextKey++, id: null, label: '', is_active: true }])}
          >
            Add item
          </Button>
          <Button size="xs" loading={save.isPending} onClick={() => save.mutate()}>
            Save checklist
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
