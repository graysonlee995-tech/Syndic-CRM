import { useState } from 'react';
import { Badge, Button, Card, Group, Loader, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { IconRestore, IconTrashX } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import { formatTimestamp } from '../format';
import type { TrashItem } from '../types';

const KINDS: Record<TrashItem['kind'], { label: string; color: string; purgeNote: string }> = {
  trip: { label: 'Trip', color: 'blue', purgeNote: 'its bookings, tickets and documents' },
  company: { label: 'Company', color: 'grape', purgeNote: 'the company record (its travellers and trips are kept, without a company)' },
  client: { label: 'Traveller', color: 'teal', purgeNote: 'their documents, scans and trip bookings' },
};

function invalidateAll() {
  for (const key of ['trash', 'trips', 'companies', 'clients', 'dashboard']) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

export function TrashPage() {
  const [filter, setFilter] = useState<'all' | TrashItem['kind']>('all');
  const { data, isLoading } = useQuery({ queryKey: ['trash'], queryFn: () => api<{ items: TrashItem[] }>('/trash') });

  const restore = useMutation({
    mutationFn: (item: TrashItem) => api(`/trash/${item.kind}/${item.id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      invalidateAll();
      notifySuccess('Restored');
    },
    onError: notifyError,
  });

  const purge = useMutation({
    mutationFn: (item: TrashItem) => api(`/trash/${item.kind}/${item.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateAll();
      notifySuccess('Permanently deleted');
    },
    onError: notifyError,
  });

  const items = (data?.items ?? []).filter((i) => filter === 'all' || i.kind === filter);

  return (
    <Stack>
      <Title order={2}>Trash</Title>
      <Text c="dimmed" size="sm">
        Trips, companies and travellers moved to the trash are hidden everywhere until restored. Deleting from here is permanent.
      </Text>
      <SegmentedControl
        value={filter}
        onChange={(v) => setFilter(v as typeof filter)}
        data={[
          { value: 'all', label: 'All' },
          { value: 'trip', label: 'Trips' },
          { value: 'company', label: 'Companies' },
          { value: 'client', label: 'Travellers' },
        ]}
        style={{ alignSelf: 'flex-start' }}
      />
      <Card withBorder p={0}>
        {isLoading ? (
          <Loader m="md" />
        ) : items.length === 0 ? (
          <Text c="dimmed" p="lg" ta="center">
            The trash is empty.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Details</Table.Th>
                  <Table.Th>Moved to trash</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((item) => (
                  <Table.Tr key={`${item.kind}-${item.id}`}>
                    <Table.Td>
                      <Badge color={KINDS[item.kind].color} variant="light">
                        {KINDS[item.kind].label}
                      </Badge>
                    </Table.Td>
                    <Table.Td fw={500}>{item.label}</Table.Td>
                    <Table.Td c="dimmed">{item.detail ?? '-'}</Table.Td>
                    <Table.Td>{formatTimestamp(item.deleted_at)}</Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Button size="xs" variant="light" leftSection={<IconRestore size={14} />} onClick={() => restore.mutate(item)}>
                          Restore
                        </Button>
                        <Button
                          size="xs"
                          color="red"
                          variant="subtle"
                          leftSection={<IconTrashX size={14} />}
                          onClick={() => {
                            if (confirm(`Permanently delete ${item.label}? This also removes ${KINDS[item.kind].purgeNote}. It cannot be undone.`)) {
                              purge.mutate(item);
                            }
                          }}
                        >
                          Delete forever
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </Stack>
  );
}
