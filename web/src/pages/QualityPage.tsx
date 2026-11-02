import { Fragment, useState } from 'react';
import { Anchor, Button, Card, Group, Loader, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatDate, formatTimestamp } from '../format';
import { ListFooter, PAGE_SIZE, stop, useCompanyOptions, useListState } from '../components/ListKit';
import { QcBadge, TripQualityCheck } from '../components/QualityCheck';
import type { QcListRow } from '../types';

/** Upcoming and ongoing active trips with their quality check; click a trip to fill in its checklist. */
export function QualityPage() {
  const list = useListState(true);
  const companies = useCompanyOptions();
  const q = list.get('q');
  const [debouncedQ] = useDebouncedValue(q, 300);
  const status = list.get('status', 'missing');
  const companyId = list.get('companyId');
  const [open, setOpen] = useState<number | null>(null);

  const search = new URLSearchParams({ page: String(list.page), pageSize: String(PAGE_SIZE), status });
  if (debouncedQ) search.set('q', debouncedQ);
  if (companyId) search.set('companyId', companyId);

  const { data, isFetching } = useQuery({
    queryKey: ['quality', search.toString()],
    queryFn: () => api<{ trips: QcListRow[]; total: number }>(`/quality?${search}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack>
      <div>
        <Title order={2}>Quality Control</Title>
        <Text size="sm" c="dimmed">
          Every upcoming and ongoing trip needs its checklist answered (Verified, Not available or Not required) to pass. Click a
          trip to check it.
        </Text>
      </div>

      <Card withBorder>
        <Stack gap="sm">
          <SegmentedControl
            value={status}
            onChange={(v) => {
              setOpen(null);
              list.set({ status: v === 'missing' ? null : v });
            }}
            data={[
              { value: 'missing', label: 'QC pending' },
              { value: 'passed', label: 'QC passed' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Group grow wrap="wrap" align="flex-end">
            <TextInput
              leftSection={<IconSearch size={16} />}
              rightSection={isFetching ? <Loader size="xs" /> : null}
              placeholder="Search by reference, trip name, company or traveller"
              value={q}
              onChange={(e) => list.set({ q: e.currentTarget.value })}
              style={{ flexGrow: 3 }}
            />
            <Select
              placeholder="All companies"
              clearable
              searchable
              data={companies.data ?? []}
              value={companyId || null}
              onChange={(v) => list.set({ companyId: v })}
            />
          </Group>
        </Stack>
      </Card>

      <Card withBorder p={0}>
        {!data ? (
          <Loader m="lg" />
        ) : data.trips.length === 0 ? (
          <Text c="dimmed" p="lg" ta="center">
            {status === 'missing' ? 'All upcoming and ongoing trips have passed their quality check.' : 'No trips found.'}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={1000}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={30} />
                  <Table.Th>Reference</Table.Th>
                  <Table.Th>Trip name</Table.Th>
                  <Table.Th>Company</Table.Th>
                  <Table.Th>Travellers</Table.Th>
                  <Table.Th>Dates</Table.Th>
                  <Table.Th>Answered</Table.Th>
                  <Table.Th>Quality check</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.trips.map((t) => (
                  <Fragment key={t.id}>
                    <Table.Tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === t.id ? null : t.id)}>
                      <Table.Td>{open === t.id ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}</Table.Td>
                      <Table.Td>
                        <Anchor component={Link} to={`/trips/${t.id}`} onClick={stop} fw={500}>
                          {t.reference}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>{t.name}</Table.Td>
                      <Table.Td>{t.company_name ?? '-'}</Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={2} maw={240}>
                          {t.traveller_names ?? '-'}
                        </Text>
                      </Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>
                        {formatDate(t.departure_date)}
                        {t.return_date ? ` → ${formatDate(t.return_date)}` : ''}
                      </Table.Td>
                      <Table.Td>
                        {t.answered}/{t.total}
                      </Table.Td>
                      <Table.Td>
                        <QcBadge status={t.qc_status} />
                        {t.qc_status === 'passed' && t.passed_by_name && (
                          <Text size="xs" c="dimmed">
                            {t.passed_by_name}
                            {t.passed_at ? `, ${formatTimestamp(t.passed_at)}` : ''}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Button size="xs" variant={t.qc_status === 'missing' ? 'filled' : 'default'}>
                          {open === t.id ? 'Close' : t.qc_status === 'missing' ? 'Check' : 'View'}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                    {open === t.id && (
                      <Table.Tr>
                        <Table.Td colSpan={9} p="md" style={{ background: 'var(--mantine-color-default-hover)' }}>
                          <TripQualityCheck tripId={t.id} />
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
      <ListFooter list={list} total={data?.total} noun="trips" />
    </Stack>
  );
}
