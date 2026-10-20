import { ActionIcon, Anchor, Badge, Card, Group, Loader, SegmentedControl, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconEdit, IconEye, IconFileTypePdf, IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { formatDate, formatTimestamp, labelOf, TripStatusBadge } from '../format';
import { TRIP_FILTERS, TRIP_TYPES, type TripListRow } from '../types';
import { exportQuery, ListFooter, PAGE_SIZE, SortTh, stop, useCompanyOptions, useListState } from './ListKit';

interface Props {
  /** Full Trips page: state lives in the URL and a company filter is shown. */
  urlBacked?: boolean;
  companyId?: number;
  travellerId?: number;
}

export function TripsTable({ urlBacked = false, companyId, travellerId }: Props) {
  const navigate = useNavigate();
  const list = useListState(urlBacked);
  const companies = useCompanyOptions();
  const q = list.get('q');
  const [debouncedQ] = useDebouncedValue(q, 300);
  const filter = list.get('filter', 'all');
  const companyFilter = companyId ? String(companyId) : list.get('companyId');
  // Upcoming trips read best soonest-first; everything else newest-first.
  const sort = list.get('sort', 'departure');
  const dir = list.get('dir', list.get('sort') ? 'asc' : filter === 'upcoming' || filter === 'ongoing' ? 'asc' : 'desc');

  const search = new URLSearchParams({ page: String(list.page), pageSize: String(PAGE_SIZE), filter, sort, dir });
  if (debouncedQ) search.set('q', debouncedQ);
  if (companyFilter) search.set('companyId', companyFilter);
  if (travellerId) search.set('travellerId', String(travellerId));

  const { data, isFetching } = useQuery({
    queryKey: ['trips', search.toString()],
    queryFn: () => api<{ trips: TripListRow[]; total: number }>(`/trips?${search}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack>
      <Card withBorder>
        <Stack gap="sm">
          <SegmentedControl
            value={filter}
            onChange={(v) => list.set({ filter: v === 'all' ? null : v })}
            data={TRIP_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
            style={{ overflowX: 'auto' }}
          />
          <Group grow wrap="wrap" align="flex-end">
            <TextInput
              leftSection={<IconSearch size={16} />}
              rightSection={isFetching ? <Loader size="xs" /> : null}
              placeholder="Search by reference, trip name, company, destination or traveller"
              value={q}
              onChange={(e) => list.set({ q: e.currentTarget.value })}
              style={{ flexGrow: 3 }}
            />
            {!companyId && !travellerId && (
              <Select
                placeholder="All companies"
                clearable
                searchable
                data={companies.data ?? []}
                value={companyFilter || null}
                onChange={(v) => list.set({ companyId: v })}
              />
            )}
          </Group>
        </Stack>
      </Card>

      <Card withBorder p={0}>
        {data && data.trips.length === 0 ? (
          <Text c="dimmed" p="lg" ta="center">
            No trips found.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={1250}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <SortTh list={list} sortKey="reference">Reference</SortTh>
                  <SortTh list={list} sortKey="name">Trip name</SortTh>
                  {!companyId && <SortTh list={list} sortKey="company">Company</SortTh>}
                  <Table.Th>Travellers</Table.Th>
                  <SortTh list={list} sortKey="origin">Origin</SortTh>
                  <Table.Th>Destination(s)</Table.Th>
                  <SortTh list={list} sortKey="departure">Departure</SortTh>
                  <SortTh list={list} sortKey="return">Return / end</SortTh>
                  <SortTh list={list} sortKey="type">Type</SortTh>
                  <SortTh list={list} sortKey="status">Status</SortTh>
                  <SortTh list={list} sortKey="updated" defaultDir="desc">Last updated</SortTh>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.trips.map((t) => (
                  <Table.Tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/trips/${t.id}`)}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>
                      <Anchor component={Link} to={`/trips/${t.id}`} fw={500} onClick={stop}>
                        {t.reference}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{t.name}</Table.Td>
                    {!companyId && (
                      <Table.Td>
                        {t.company_id ? (
                          <Anchor component={Link} to={`/companies/${t.company_id}`} onClick={stop}>
                            {t.company_name}
                          </Anchor>
                        ) : (
                          '-'
                        )}
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Tooltip label={t.traveller_names ?? 'No travellers'} multiline maw={300} disabled={!t.traveller_names}>
                        <Text size="sm" lineClamp={2} maw={220}>
                          {t.traveller_count ? `${t.traveller_count} · ${t.traveller_names}` : '-'}
                        </Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>{t.origin ?? '-'}</Table.Td>
                    <Table.Td>
                      <Text size="sm" lineClamp={2} maw={200}>
                        {t.destinations ?? '-'}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(t.departure_date)}</Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(t.return_date)}</Table.Td>
                    <Table.Td>{labelOf(TRIP_TYPES, t.trip_type)}</Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <TripStatusBadge phase={t.phase} status={t.status} />
                        {t.open_tickets > 0 && (
                          <Badge color="orange" variant="filled" style={{ minWidth: 'max-content' }}>
                            {t.open_tickets} open ticket{t.open_tickets === 1 ? '' : 's'}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(t.updated_at)}</Table.Td>
                    <Table.Td onClick={stop}>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="View">
                          <ActionIcon variant="light" component={Link} to={`/trips/${t.id}`} aria-label="View trip">
                            <IconEye size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Edit">
                          <ActionIcon variant="default" component={Link} to={`/trips/${t.id}/edit`} aria-label="Edit trip">
                            <IconEdit size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Travel agenda (PDF)">
                          <ActionIcon variant="default" component={Link} to={`/trips/${t.id}/agenda`} aria-label="Travel agenda PDF">
                            <IconFileTypePdf size={16} />
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
      <ListFooter list={list} total={data?.total} noun="trips" exportHref={`/api/trips/export?${exportQuery(search)}`} />
    </Stack>
  );
}
