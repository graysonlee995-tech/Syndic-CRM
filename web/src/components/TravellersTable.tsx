import { ActionIcon, Anchor, Badge, Card, Group, Loader, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconEdit, IconEye, IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ExpiryBadge, formatDate, formatTimestamp, travellerCode } from '../format';
import { DOCUMENT_TYPES, PASSENGER_CATEGORIES, type ClientListRow } from '../types';
import { exportQuery, ListFooter, PAGE_SIZE, SortTh, stop, useCompanyOptions, useListState } from './ListKit';
import { useCan } from '../permissions';

interface Props {
  urlBacked?: boolean;
  /** Inside a company profile: only that company's travellers. */
  companyId?: number;
}

/** Infant / Child / Adult; clicking it shows only that category. Nothing without a date of birth. */
function PassengerBadge({ category, onClick }: { category: ClientListRow['category']; onClick: (category: string) => void }) {
  const p = PASSENGER_CATEGORIES.find((x) => x.value === category);
  if (!p) return <Text size="sm" c="dimmed">-</Text>;
  return (
    <Tooltip label={`Show only ${p.label.toLowerCase()}s`}>
      <Badge
        component="button"
        type="button"
        variant="light"
        color={p.color}
        style={{ cursor: 'pointer', border: 'none' }}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onClick(p.value);
        }}
      >
        {p.label}
      </Badge>
    </Tooltip>
  );
}

export function TravellersTable({ urlBacked = false, companyId }: Props) {
  const can = useCan();
  const navigate = useNavigate();
  const list = useListState(urlBacked);
  const companies = useCompanyOptions();
  const q = list.get('q');
  const dob = list.get('dob');
  const nationality = list.get('nationality');
  const docType = list.get('docType');
  const category = list.get('category');
  const companyFilter = companyId ? String(companyId) : list.get('companyId');
  const [debouncedQ] = useDebouncedValue(q, 300);
  const [debouncedNationality] = useDebouncedValue(nationality, 300);

  const search = new URLSearchParams({ page: String(list.page), pageSize: String(PAGE_SIZE) });
  if (debouncedQ) search.set('q', debouncedQ);
  if (dob) search.set('dob', dob);
  if (debouncedNationality) search.set('nationality', debouncedNationality);
  if (docType) search.set('docType', docType);
  if (category) search.set('category', category);
  if (companyFilter) search.set('companyId', companyFilter);
  if (list.get('sort')) search.set('sort', list.get('sort'));
  if (list.get('dir')) search.set('dir', list.get('dir'));

  const { data, isFetching } = useQuery({
    queryKey: ['clients', search.toString()],
    queryFn: () => api<{ clients: ClientListRow[]; total: number }>(`/travellers?${search}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack>
      <Card withBorder>
        <Stack gap="sm">
          <TextInput
            leftSection={<IconSearch size={16} />}
            rightSection={isFetching ? <Loader size="xs" /> : null}
            placeholder="Search by name, passport or ID number, address, phone, email or date of birth (DD/MM/YYYY)"
            value={q}
            onChange={(e) => list.set({ q: e.currentTarget.value })}
            autoFocus={urlBacked}
            size={urlBacked ? 'md' : 'sm'}
          />
          <Group grow wrap="wrap" align="flex-end">
            {!companyId && (
              <Select
                label="Company"
                placeholder="Any"
                clearable
                searchable
                data={companies.data ?? []}
                value={companyFilter || null}
                onChange={(v) => list.set({ companyId: v })}
              />
            )}
            <Select
              label="Passenger"
              placeholder="Any"
              clearable
              data={[
                ...PASSENGER_CATEGORIES.map((p) => ({ value: p.value, label: p.label })),
                { value: 'unknown', label: 'No date of birth' },
              ]}
              value={category || null}
              onChange={(v) => list.set({ category: v })}
            />
            <TextInput label="Date of birth" type="date" value={dob} onChange={(e) => list.set({ dob: e.currentTarget.value })} />
            <TextInput
              label="Nationality"
              placeholder="e.g. Pakistan"
              value={nationality}
              onChange={(e) => list.set({ nationality: e.currentTarget.value })}
            />
            <Select
              label="Has document"
              placeholder="Any"
              clearable
              data={DOCUMENT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              value={docType || null}
              onChange={(v) => list.set({ docType: v })}
            />
          </Group>
        </Stack>
      </Card>

      <Card withBorder p={0}>
        {data && data.clients.length === 0 ? (
          <Text c="dimmed" p="lg" ta="center">
            No travellers found.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={1250}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <SortTh list={list} sortKey="id">ID</SortTh>
                  <SortTh list={list} sortKey="name">Full name</SortTh>
                  <Table.Th>Passenger</Table.Th>
                  {!companyId && <SortTh list={list} sortKey="company">Company</SortTh>}
                  <SortTh list={list} sortKey="nationality">Nationality</SortTh>
                  <SortTh list={list} sortKey="dob">Date of birth</SortTh>
                  <Table.Th>Phone</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <SortTh list={list} sortKey="expiry">Document expiry</SortTh>
                  <SortTh list={list} sortKey="upcoming" defaultDir="desc">Upcoming trips</SortTh>
                  <SortTh list={list} sortKey="updated" defaultDir="desc">Last updated</SortTh>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.clients.map((c) => (
                  <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/travellers/${c.id}`)}>
                    <Table.Td c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {travellerCode(c.id)}
                    </Table.Td>
                    <Table.Td>
                      <Anchor component={Link} to={`/travellers/${c.id}`} fw={500} onClick={stop}>
                        {c.first_name} {c.last_name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <PassengerBadge category={c.category} onClick={(v) => list.set({ category: v })} />
                    </Table.Td>
                    {!companyId && (
                      <Table.Td>
                        {c.company_id ? (
                          <Anchor component={Link} to={`/companies/${c.company_id}`} onClick={stop}>
                            {c.company_name}
                          </Anchor>
                        ) : (
                          '-'
                        )}
                      </Table.Td>
                    )}
                    <Table.Td>{c.nationality ?? '-'}</Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(c.date_of_birth)}</Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{c.phone ?? '-'}</Table.Td>
                    <Table.Td>{c.email ?? '-'}</Table.Td>
                    <Table.Td>{c.document_count ? <ExpiryBadge date={c.earliest_expiry} /> : <Text size="sm" c="dimmed">No documents</Text>}</Table.Td>
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
                          <ActionIcon variant="light" component={Link} to={`/travellers/${c.id}`} aria-label="View traveller">
                            <IconEye size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Edit">
                          <ActionIcon variant="default" component={Link} to={`/travellers/${c.id}/edit`} aria-label="Edit traveller" display={can('travellers', 'edit') ? undefined : 'none'}>
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
      <ListFooter list={list} total={data?.total} noun="travellers" exportHref={can('travellers', 'export') ? `/api/travellers/export?${exportQuery(search)}` : undefined} />
    </Stack>
  );
}
