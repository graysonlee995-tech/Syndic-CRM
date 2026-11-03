import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Popover,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useLocalStorage } from '@mantine/hooks';
import { IconColumns, IconEdit, IconEye, IconSearch } from '@tabler/icons-react';
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

/** Columns that can be shown or hidden; ID, name and actions are always shown. */
const COLUMNS = [
  { key: 'passenger', label: 'Passenger' },
  { key: 'status', label: 'Status' },
  { key: 'company', label: 'Company' },
  { key: 'nationality', label: 'Nationality' },
  { key: 'dob', label: 'Date of birth' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'expiry', label: 'Document expiry' },
  { key: 'upcoming', label: 'Upcoming trips' },
  { key: 'updated', label: 'Last updated' },
] as const;
type ColumnKey = (typeof COLUMNS)[number]['key'];

/** Which columns are hidden, remembered in this browser. */
function useHiddenColumns() {
  const [hidden, setHidden] = useLocalStorage<ColumnKey[]>({
    key: 'travellers-hidden-columns',
    defaultValue: [],
  });
  const toggle = (key: ColumnKey, show: boolean) => setHidden((h) => (show ? h.filter((k) => k !== key) : [...h.filter((k) => k !== key), key]));
  return {
    hidden,
    setHidden,
    toggle,
    shows: (key: ColumnKey) => !hidden.includes(key),
  };
}

function ColumnsPicker({ cols, withCompany }: { cols: ReturnType<typeof useHiddenColumns>; withCompany: boolean }) {
  const options = COLUMNS.filter((c) => withCompany || c.key !== 'company');
  const hiddenCount = options.filter((c) => !cols.shows(c.key)).length;
  return (
    <Popover position="bottom-end" shadow="md" withArrow>
      <Popover.Target>
        <Button variant="default" leftSection={<IconColumns size={16} />} style={{ flexShrink: 0 }}>
          Columns{hiddenCount ? ` (${hiddenCount} hidden)` : ''}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={8}>
          <Text size="xs" c="dimmed">
            Show these columns
          </Text>
          {options.map((c) => (
            <Checkbox key={c.key} label={c.label} checked={cols.shows(c.key)} onChange={(e) => cols.toggle(c.key, e.currentTarget.checked)} />
          ))}
          <Button size="compact-xs" variant="subtle" disabled={!hiddenCount} onClick={() => cols.setHidden([])}>
            Show all
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Infant / Child / Adult; clicking it shows only that category. Nothing without a date of birth. */
function PassengerBadge({ category, onClick }: { category: ClientListRow['category']; onClick: (category: string) => void }) {
  const p = PASSENGER_CATEGORIES.find((x) => x.value === category);
  if (!p)
    return (
      <Text size="sm" c="dimmed">
        -
      </Text>
    );
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
  const cols = useHiddenColumns();
  const show = cols.shows;
  const companies = useCompanyOptions();
  const q = list.get('q');
  const dob = list.get('dob');
  const nationality = list.get('nationality');
  const docType = list.get('docType');
  const category = list.get('category');
  const status = list.get('status');
  const companyFilter = companyId ? String(companyId) : list.get('companyId');
  const [debouncedQ] = useDebouncedValue(q, 300);
  const [debouncedNationality] = useDebouncedValue(nationality, 300);

  const search = new URLSearchParams({
    page: String(list.page),
    pageSize: String(PAGE_SIZE),
  });
  if (debouncedQ) search.set('q', debouncedQ);
  if (dob) search.set('dob', dob);
  if (debouncedNationality) search.set('nationality', debouncedNationality);
  if (docType) search.set('docType', docType);
  if (category) search.set('category', category);
  if (status) search.set('status', status);
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
          <Group gap="sm" wrap="nowrap" align="flex-end">
            <TextInput
              style={{ flex: 1 }}
              leftSection={<IconSearch size={16} />}
              rightSection={isFetching ? <Loader size="xs" /> : null}
              placeholder="Search by name, passport or ID number, address, phone, email or date of birth (DD/MM/YYYY)"
              value={q}
              onChange={(e) => list.set({ q: e.currentTarget.value })}
              autoFocus={urlBacked}
              size={urlBacked ? 'md' : 'sm'}
            />
            <ColumnsPicker cols={cols} withCompany={!companyId} />
          </Group>
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
              label="Status"
              placeholder="All"
              clearable
              data={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive (no alerts)' },
              ]}
              value={status || null}
              onChange={(v) => list.set({ status: v })}
            />
            <Select
              label="Passenger"
              placeholder="Any"
              clearable
              data={[
                ...PASSENGER_CATEGORIES.map((p) => ({
                  value: p.value,
                  label: p.label,
                })),
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
              data={DOCUMENT_TYPES.map((t) => ({
                value: t.value,
                label: t.label,
              }))}
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
          <Table.ScrollContainer minWidth={Math.max(700, 1350 - cols.hidden.length * 110)}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <SortTh list={list} sortKey="id">
                    ID
                  </SortTh>
                  <SortTh list={list} sortKey="name">
                    Full name
                  </SortTh>
                  {show('passenger') && <Table.Th>Passenger</Table.Th>}
                  {show('status') && <Table.Th>Status</Table.Th>}
                  {!companyId && show('company') && (
                    <SortTh list={list} sortKey="company">
                      Company
                    </SortTh>
                  )}
                  {show('nationality') && (
                    <SortTh list={list} sortKey="nationality">
                      Nationality
                    </SortTh>
                  )}
                  {show('dob') && (
                    <SortTh list={list} sortKey="dob">
                      Date of birth
                    </SortTh>
                  )}
                  {show('phone') && <Table.Th>Phone</Table.Th>}
                  {show('email') && <Table.Th>Email</Table.Th>}
                  {show('expiry') && (
                    <SortTh list={list} sortKey="expiry">
                      Document expiry
                    </SortTh>
                  )}
                  {show('upcoming') && (
                    <SortTh list={list} sortKey="upcoming" defaultDir="desc">
                      Upcoming trips
                    </SortTh>
                  )}
                  {show('updated') && (
                    <SortTh list={list} sortKey="updated" defaultDir="desc">
                      Last updated
                    </SortTh>
                  )}
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.clients.map((c) => (
                  <Table.Tr
                    key={c.id}
                    style={{
                      cursor: 'pointer',
                      opacity: c.is_active ? 1 : 0.6,
                    }}
                    onClick={() => navigate(`/travellers/${c.id}`)}
                  >
                    <Table.Td c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {travellerCode(c.id)}
                    </Table.Td>
                    <Table.Td>
                      <Anchor component={Link} to={`/travellers/${c.id}`} fw={500} onClick={stop}>
                        {c.first_name} {c.last_name}
                      </Anchor>
                    </Table.Td>
                    {show('passenger') && (
                      <Table.Td>
                        <PassengerBadge category={c.category} onClick={(v) => list.set({ category: v })} />
                      </Table.Td>
                    )}
                    {show('status') && (
                      <Table.Td>
                        {c.is_active ? (
                          <Badge color="green" variant="light">
                            Active
                          </Badge>
                        ) : (
                          <Tooltip label="No document expiry or birthday alerts">
                            <Badge color="gray" variant="light">
                              Inactive
                            </Badge>
                          </Tooltip>
                        )}
                      </Table.Td>
                    )}
                    {!companyId && show('company') && (
                      <Table.Td>
                        {c.companies.length
                          ? c.companies.map((co, k) => (
                              <span key={co.id}>
                                {k > 0 && ', '}
                                <Anchor component={Link} to={`/companies/${co.id}`} onClick={stop}>
                                  {co.name}
                                </Anchor>
                              </span>
                            ))
                          : '-'}
                      </Table.Td>
                    )}
                    {show('nationality') && <Table.Td>{c.nationality ?? '-'}</Table.Td>}
                    {show('dob') && <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(c.date_of_birth)}</Table.Td>}
                    {show('phone') && <Table.Td style={{ whiteSpace: 'nowrap' }}>{c.phone ?? '-'}</Table.Td>}
                    {show('email') && <Table.Td>{c.email ?? '-'}</Table.Td>}
                    {show('expiry') && (
                      <Table.Td>
                        {c.document_count ? (
                          <ExpiryBadge date={c.earliest_expiry} />
                        ) : (
                          <Text size="sm" c="dimmed">
                            No documents
                          </Text>
                        )}
                      </Table.Td>
                    )}
                    {show('upcoming') && (
                      <Table.Td>
                        {c.upcoming_trips ? (
                          <Badge variant="light" color="blue">
                            {c.upcoming_trips}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            0
                          </Text>
                        )}
                      </Table.Td>
                    )}
                    {show('updated') && <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(c.updated_at)}</Table.Td>}
                    <Table.Td onClick={stop}>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="View">
                          <ActionIcon variant="light" component={Link} to={`/travellers/${c.id}`} aria-label="View traveller">
                            <IconEye size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Edit">
                          <ActionIcon
                            variant="default"
                            component={Link}
                            to={`/travellers/${c.id}/edit`}
                            aria-label="Edit traveller"
                            display={can('travellers', 'edit') ? undefined : 'none'}
                          >
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
      <ListFooter
        list={list}
        total={data?.total}
        noun="travellers"
        exportHref={can('travellers', 'export') ? `/api/travellers/export?${exportQuery(search)}` : undefined}
      />
    </Stack>
  );
}
