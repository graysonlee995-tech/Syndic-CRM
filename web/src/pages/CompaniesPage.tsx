import { ActionIcon, Anchor, Badge, Button, Card, Group, Loader, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconEdit, IconEye, IconPlus, IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ListFooter, PAGE_SIZE, SortTh, stop, useListState } from '../components/ListKit';
import { companyCode, formatTimestamp } from '../format';
import type { CompanyListRow } from '../types';

export function CompaniesPage() {
  const navigate = useNavigate();
  const list = useListState(true);
  const q = list.get('q');
  const [debouncedQ] = useDebouncedValue(q, 300);

  const search = new URLSearchParams({ page: String(list.page), pageSize: String(PAGE_SIZE) });
  if (debouncedQ) search.set('q', debouncedQ);
  if (list.get('sort')) search.set('sort', list.get('sort'));
  if (list.get('dir')) search.set('dir', list.get('dir'));

  const { data, isFetching } = useQuery({
    queryKey: ['companies', search.toString()],
    queryFn: () => api<{ companies: CompanyListRow[]; total: number }>(`/companies?${search}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Companies</Title>
        <Button component={Link} to="/companies/new" leftSection={<IconPlus size={16} />}>
          Add company
        </Button>
      </Group>

      <Card withBorder>
        <TextInput
          leftSection={<IconSearch size={16} />}
          rightSection={isFetching ? <Loader size="xs" /> : null}
          placeholder="Search by company name, contact, email, phone, city or country"
          value={q}
          onChange={(e) => list.set({ q: e.currentTarget.value })}
          autoFocus
          size="md"
        />
      </Card>

      <Card withBorder p={0}>
        {data && data.companies.length === 0 ? (
          <Text c="dimmed" p="lg" ta="center">
            No companies found.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={1050}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <SortTh list={list} sortKey="id">ID</SortTh>
                  <SortTh list={list} sortKey="name">Company name</SortTh>
                  <SortTh list={list} sortKey="contact">Primary contact</SortTh>
                  <Table.Th>Phone</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <SortTh list={list} sortKey="city">City / Country</SortTh>
                  <SortTh list={list} sortKey="travellers" defaultDir="desc">Travellers</SortTh>
                  <SortTh list={list} sortKey="upcoming" defaultDir="desc">Upcoming trips</SortTh>
                  <SortTh list={list} sortKey="updated" defaultDir="desc">Last updated</SortTh>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.companies.map((c) => (
                  <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/companies/${c.id}`)}>
                    <Table.Td c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {companyCode(c.id)}
                    </Table.Td>
                    <Table.Td>
                      <Anchor component={Link} to={`/companies/${c.id}`} fw={500} onClick={stop}>
                        {c.name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{c.primary_contact ?? '-'}</Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{c.phone ?? '-'}</Table.Td>
                    <Table.Td>{c.email ?? '-'}</Table.Td>
                    <Table.Td>{[c.city, c.country].filter(Boolean).join(', ') || '-'}</Table.Td>
                    <Table.Td>{c.traveller_count}</Table.Td>
                    <Table.Td>
                      {c.upcoming_trips ? (
                        <Badge variant="light" color="blue">
                          {c.upcoming_trips}
                        </Badge>
                      ) : (
                        <Text size="sm" c="dimmed">0</Text>
                      )}
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(c.updated_at)}</Table.Td>
                    <Table.Td onClick={stop}>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="View">
                          <ActionIcon variant="light" component={Link} to={`/companies/${c.id}`} aria-label="View company">
                            <IconEye size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Edit">
                          <ActionIcon variant="default" component={Link} to={`/companies/${c.id}/edit`} aria-label="Edit company">
                            <IconEdit size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
      <ListFooter list={list} total={data?.total} noun="companies" />
    </Stack>
  );
}
