import { useMemo } from 'react';
import { Card, Group, Loader, SegmentedControl, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { OpenCreditsTable } from '../components/OpenCreditsTable';
import { exportQuery, ListFooter, PAGE_SIZE, useCompanyOptions, useListState, useTravellerOptions } from '../components/ListKit';
import { CREDIT_STATUSES, type OpenCredit } from '../types';
import { useCan } from '../permissions';

/** Every flight and train taken off a trip as unused credit, by company and traveller. */
export function OpenCreditsPage() {
  const can = useCan();
  const list = useListState(true);
  const companies = useCompanyOptions();
  const travellers = useTravellerOptions();
  const q = list.get('q');
  const [debouncedQ] = useDebouncedValue(q, 300);
  const status = list.get('status', 'open');
  const companyId = list.get('companyId');
  const travellerId = list.get('travellerId');

  const search = new URLSearchParams({ page: String(list.page), pageSize: String(PAGE_SIZE), status });
  if (debouncedQ) search.set('q', debouncedQ);
  if (companyId) search.set('companyId', companyId);
  if (travellerId) search.set('travellerId', travellerId);

  const { data, isFetching } = useQuery({
    queryKey: ['open-credits', search.toString()],
    queryFn: () => api<{ credits: OpenCredit[]; total: number }>(`/open-credits?${search}`),
    placeholderData: keepPreviousData,
  });

  // With a company chosen, only its travellers.
  const travellerData = useMemo(
    () =>
      (travellers.data ?? [])
        .filter((t) => !companyId || String(t.company_id) === companyId)
        .map((t) => ({ value: String(t.id), label: `${t.first_name} ${t.last_name}` })),
    [travellers.data, companyId],
  );

  return (
    <Stack>
      <div>
        <Title order={2}>Open Credits</Title>
        <Text size="sm" c="dimmed">
          Flights, trains and hotels marked as open credit on a trip. Mark each one used, refunded or expired once it is settled.
        </Text>
      </div>

      <Card withBorder>
        <Stack gap="sm">
          <SegmentedControl
            value={status}
            onChange={(v) => list.set({ status: v === 'open' ? null : v })}
            data={[...CREDIT_STATUSES.map((s) => ({ value: s.value, label: s.label })), { value: 'all', label: 'All' }]}
            style={{ overflowX: 'auto' }}
          />
          <Group grow wrap="wrap" align="flex-end">
            <TextInput
              leftSection={<IconSearch size={16} />}
              rightSection={isFetching ? <Loader size="xs" /> : null}
              placeholder="Search by traveller, company, trip, airline, flight number, hotel, route or PNR"
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
              onChange={(v) => list.set({ companyId: v, travellerId: null })}
            />
            <Select
              placeholder="All travellers"
              clearable
              searchable
              data={travellerData}
              value={travellerId || null}
              onChange={(v) => list.set({ travellerId: v })}
            />
          </Group>
        </Stack>
      </Card>

      <Card withBorder p={0}>
        {!data ? (
          <Loader m="lg" />
        ) : data.credits.length === 0 ? (
          <Text c="dimmed" p="lg" ta="center">
            {status === 'open' ? 'No open credits. Mark a flight, train or hotel as open credit when editing a trip.' : 'No credits found.'}
          </Text>
        ) : (
          <OpenCreditsTable credits={data.credits} />
        )}
      </Card>
      <ListFooter list={list} total={data?.total} noun="credits" exportHref={can('open_credits', 'export') ? `/api/open-credits/export?${exportQuery(search)}` : undefined} />
    </Stack>
  );
}
