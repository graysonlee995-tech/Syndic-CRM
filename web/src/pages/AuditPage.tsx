import { useState } from 'react';
import { Anchor, Card, Group, Loader, Pagination, Stack, Table, Text, Title } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatTimestamp } from '../format';
import type { AuditEntry } from '../types';

const PAGE_SIZE = 50;

export function AuditPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['audit', page],
    queryFn: () => api<{ entries: AuditEntry[]; total: number }>(`/admin/audit?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack>
      <Title order={2}>Audit log</Title>
      <Text c="dimmed" size="sm">
        Every sign-in, client view, file view or download and change is recorded here.
      </Text>
      <Card withBorder p={0}>
        {isLoading ? (
          <Loader m="md" />
        ) : (
          <Table.ScrollContainer minWidth={700}>
            <Table striped verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>When</Table.Th>
                  <Table.Th>Employee</Table.Th>
                  <Table.Th>Action</Table.Th>
                  <Table.Th>Item</Table.Th>
                  <Table.Th>Details</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.entries.map((e) => (
                  <Table.Tr key={e.id}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(e.at)}</Table.Td>
                    <Table.Td>{e.user_name ?? '-'}</Table.Td>
                    <Table.Td>{e.action.replace(/_/g, ' ')}</Table.Td>
                    <Table.Td>
                      {e.entity === 'client' && e.entity_id ? (
                        <Anchor component={Link} to={`/clients/${e.entity_id}`}>
                          client #{e.entity_id}
                        </Anchor>
                      ) : e.entity ? (
                        `${e.entity}${e.entity_id ? ` #${e.entity_id}` : ''}`
                      ) : (
                        '-'
                      )}
                    </Table.Td>
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
        )}
      </Card>
      {data && data.total > PAGE_SIZE && (
        <Group justify="flex-end">
          <Pagination total={Math.ceil(data.total / PAGE_SIZE)} value={page} onChange={setPage} />
        </Group>
      )}
    </Stack>
  );
}
