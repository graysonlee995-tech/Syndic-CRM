import { Anchor, Button, Card, Group, Pagination, Select, Stack, Table, Text, TextInput, Title, Loader } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ExpiryBadge, formatDate } from '../format';
import { DOCUMENT_TYPES, type ClientListRow } from '../types';

const PAGE_SIZE = 25;

export function ClientsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const dob = params.get('dob') ?? '';
  const nationality = params.get('nationality') ?? '';
  const docType = params.get('docType') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [debouncedQ] = useDebouncedValue(q, 300);
  const [debouncedNationality] = useDebouncedValue(nationality, 300);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  }

  const search = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (debouncedQ) search.set('q', debouncedQ);
  if (dob) search.set('dob', dob);
  if (debouncedNationality) search.set('nationality', debouncedNationality);
  if (docType) search.set('docType', docType);

  const { data, isFetching } = useQuery({
    queryKey: ['clients', search.toString()],
    queryFn: () => api<{ clients: ClientListRow[]; total: number }>(`/clients?${search}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Clients</Title>
        <Button component={Link} to="/clients/new" leftSection={<IconPlus size={16} />}>
          New client
        </Button>
      </Group>

      <Card withBorder>
        <Stack gap="sm">
          <TextInput
            leftSection={<IconSearch size={16} />}
            rightSection={isFetching ? <Loader size="xs" /> : null}
            placeholder="Search by name, passport or ID number, address, phone, email or date of birth (DD/MM/YYYY)"
            value={q}
            onChange={(e) => setParam('q', e.currentTarget.value)}
            autoFocus
            size="md"
          />
          <Group grow wrap="wrap" align="flex-end">
            <TextInput label="Date of birth" type="date" value={dob} onChange={(e) => setParam('dob', e.currentTarget.value)} />
            <TextInput
              label="Nationality"
              placeholder="e.g. Pakistani"
              value={nationality}
              onChange={(e) => setParam('nationality', e.currentTarget.value)}
            />
            <Select
              label="Has document"
              placeholder="Any"
              clearable
              data={DOCUMENT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              value={docType || null}
              onChange={(v) => setParam('docType', v ?? '')}
            />
          </Group>
        </Stack>
      </Card>

      <Card withBorder p={0}>
        {data && data.clients.length === 0 ? (
          <Text c="dimmed" p="lg" ta="center">
            No clients found.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={700}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Date of birth</Table.Th>
                  <Table.Th>Nationality</Table.Th>
                  <Table.Th>Phone</Table.Th>
                  <Table.Th>City</Table.Th>
                  <Table.Th>Documents</Table.Th>
                  <Table.Th>Earliest expiry</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.clients.map((c) => (
                  <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/clients/${c.id}`)}>
                    <Table.Td>
                      <Anchor component={Link} to={`/clients/${c.id}`} fw={500} onClick={(e) => e.stopPropagation()}>
                        {c.first_name} {c.last_name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{formatDate(c.date_of_birth)}</Table.Td>
                    <Table.Td>{c.nationality ?? '-'}</Table.Td>
                    <Table.Td>{c.phone ?? '-'}</Table.Td>
                    <Table.Td>{c.city ?? '-'}</Table.Td>
                    <Table.Td>{c.document_count}</Table.Td>
                    <Table.Td>{c.earliest_expiry ? <ExpiryBadge date={c.earliest_expiry} /> : '-'}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {data && data.total > PAGE_SIZE && (
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {data.total} clients
          </Text>
          <Pagination total={Math.ceil(data.total / PAGE_SIZE)} value={page} onChange={(p) => setParam('page', String(p))} />
        </Group>
      )}
    </Stack>
  );
}
