import { Card, Loader, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { formatTimestamp } from '../format';
import type { AuditEntry } from '../types';

/** Change history of one trip, company or traveller (views are not listed). */
export function ActivityHistory({ entity, id }: { entity: 'trip' | 'company' | 'client'; id: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['activity', entity, id],
    queryFn: () => api<{ entries: AuditEntry[] }>(`/activity?entity=${entity}&id=${id}`),
    staleTime: 0,
  });

  if (isLoading) return <Loader />;
  if (!data?.entries.length) {
    return (
      <Text c="dimmed" size="sm">
        No changes recorded yet.
      </Text>
    );
  }
  return (
    <Card withBorder p={0}>
      <Table.ScrollContainer minWidth={600}>
        <Table striped verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Employee</Table.Th>
              <Table.Th>Action</Table.Th>
              <Table.Th>Details</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.entries.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(e.at)}</Table.Td>
                <Table.Td>{e.user_name ?? 'System'}</Table.Td>
                <Table.Td>{e.action.replace(/^(client|trip)_/, '').replace(/_/g, ' ')}</Table.Td>
                <Table.Td>
                  <Text size="sm" lineClamp={2}>
                    {e.details ?? ''}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
