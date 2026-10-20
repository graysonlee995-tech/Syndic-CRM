import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Loader,
  MultiSelect,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import { useCompanyOptions, useTravellerOptions } from '../components/ListKit';
import { CompanyPicker } from '../components/CompanyPicker';
import { ITINERARY_TYPES, TRIP_STATUSES, TRIP_TYPES, type ItineraryItem, type Trip, type TripDetail } from '../types';

/** One itinerary row in the form; every field is a string while editing. */
type Row = { key: number } & { [K in keyof ItineraryItem]: string };

let nextKey = 1;

const blankRow = (previous?: Row): Row => ({
  key: nextKey++,
  type: previous?.type ?? 'flight',
  // A new item usually starts where the previous one ended.
  origin: previous?.destination ?? '',
  destination: '',
  departure_date: previous ? previous.arrival_date || previous.departure_date : '',
  departure_time: '',
  arrival_date: '',
  arrival_time: '',
  confirmation_number: '',
  gds_pnr: '',
});

const toRow = (item: Partial<ItineraryItem>): Row => ({
  key: nextKey++,
  type: item.type ?? 'flight',
  origin: item.origin ?? '',
  destination: item.destination ?? '',
  departure_date: item.departure_date ?? '',
  departure_time: item.departure_time ?? '',
  arrival_date: item.arrival_date ?? '',
  arrival_time: item.arrival_time ?? '',
  confirmation_number: item.confirmation_number ?? '',
  gds_pnr: item.gds_pnr ?? '',
});

export function TripFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const companies = useCompanyOptions();
  const travellerOptions = useTravellerOptions();

  const [form, setForm] = useState({
    name: '',
    company_id: params.get('companyId') ?? '',
    trip_type: 'business',
    status: 'planned',
    notes: '',
  });
  const [travellerIds, setTravellerIds] = useState<string[]>(params.get('travellerId') ? [params.get('travellerId')!] : []);
  const [rows, setRows] = useState<Row[]>(() => [blankRow()]);

  const existing = useQuery({
    queryKey: ['trip', id],
    queryFn: () => api<TripDetail>(`/trips/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    const d = existing.data;
    if (!d) return;
    const t = d.trip;
    setForm({
      name: t.name,
      company_id: t.company_id ? String(t.company_id) : '',
      trip_type: t.trip_type,
      status: t.status,
      notes: t.notes ?? '',
    });
    setTravellerIds(d.travellers.map((c) => String(c.id)));
    setRows(
      d.itinerary.length
        ? d.itinerary.map(toRow)
        : // Trips saved before the itinerary existed: start from their dates and first destination.
          [
            toRow({
              type: 'other',
              origin: t.origin,
              destination: d.destinations[0]?.city ?? null,
              departure_date: t.departure_date,
              arrival_date: t.return_date,
            }),
          ],
    );
  }, [existing.data]);

  // The selected company's travellers are listed first.
  const travellerData = useMemo(() => {
    const all = travellerOptions.data ?? [];
    const item = (c: (typeof all)[number]) => ({
      value: String(c.id),
      label: `${c.first_name} ${c.last_name}${c.company_name && String(c.company_id) !== form.company_id ? ` (${c.company_name})` : ''}`,
    });
    if (!form.company_id) return all.map(item);
    const company = companies.data?.find((c) => c.value === form.company_id)?.label ?? 'Company';
    const own = all.filter((c) => String(c.company_id) === form.company_id).map(item);
    const others = all.filter((c) => String(c.company_id) !== form.company_id).map(item);
    return [
      { group: company, items: own },
      { group: 'Other travellers', items: others },
    ].filter((g) => g.items.length);
  }, [travellerOptions.data, companies.data, form.company_id]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        company_id: form.company_id ? Number(form.company_id) : null,
        traveller_ids: travellerIds.map(Number),
        itinerary: rows.map(({ key: _key, ...row }) => row),
      };
      return id ? api<{ trip: Trip }>(`/trips/${id}`, { method: 'PUT', body }) : api<{ trip: Trip }>('/trips', { body });
    },
    onSuccess: ({ trip }) => {
      // The same trip shows in the trips list, the company profile and each traveller's history.
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['trip', String(trip.id)] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      notifySuccess(id ? 'Trip updated' : `Trip ${trip.reference} created`);
      navigate(`/trips/${trip.id}`, { replace: true });
    },
    onError: notifyError,
  });

  if (id && existing.isLoading) return <Loader />;

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = e.currentTarget;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  const setRow = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const cell = (row: Row, name: keyof ItineraryItem, transform?: (v: string) => string) => ({
    value: row[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = e.currentTarget;
      setRow(row.key, { [name]: transform ? transform(value) : value });
    },
    size: 'xs' as const,
    'aria-label': name.replace(/_/g, ' '),
  });
  const move = (index: number, by: number) =>
    setRows((all) => {
      const next = [...all];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row);
      return next;
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Stack maw={1400}>
        <Title order={2}>{id ? `Edit trip ${existing.data?.trip.reference ?? ''}` : 'New trip'}</Title>

        <Card withBorder>
          <Title order={4} mb="sm">
            Trip
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            <TextInput label="Trip name" required placeholder="e.g. Europe Business Tour" {...field('name')} autoFocus />
            <CompanyPicker
              value={form.company_id}
              onChange={(company_id) => setForm((f) => ({ ...f, company_id }))}
              placeholder="No company (private trip)"
            />
            <MultiSelect
              label="Travellers"
              placeholder={travellerIds.length ? undefined : 'Search travellers'}
              searchable
              clearable
              data={travellerData}
              value={travellerIds}
              onChange={setTravellerIds}
              nothingFoundMessage="No traveller found. Add them under Travellers first."
            />
            <Select
              label="Trip type"
              allowDeselect={false}
              data={TRIP_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              value={form.trip_type}
              onChange={(v) => setForm((f) => ({ ...f, trip_type: v ?? 'business' }))}
            />
          </SimpleGrid>
        </Card>

        <Card withBorder>
          <Group justify="space-between" mb="sm">
            <div>
              <Title order={4}>Itinerary</Title>
              <Text size="xs" c="dimmed">
                One row per flight, hotel, car and so on. The trip's dates come from these rows.
              </Text>
            </div>
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setRows((all) => [...all, blankRow(all.at(-1))])}>
              Add item
            </Button>
          </Group>
          <Table.ScrollContainer minWidth={1280}>
            <Table verticalSpacing={6} horizontalSpacing={6} withRowBorders={false}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={24} />
                  <Table.Th w={115}>Type</Table.Th>
                  <Table.Th>Origin</Table.Th>
                  <Table.Th>Destination</Table.Th>
                  <Table.Th w={140}>Departure date *</Table.Th>
                  <Table.Th w={105}>Dep. time</Table.Th>
                  <Table.Th w={140}>Arrival date</Table.Th>
                  <Table.Th w={105}>Arr. time</Table.Th>
                  <Table.Th w={130}>Conf. No.</Table.Th>
                  <Table.Th w={110}>GDS PNR</Table.Th>
                  <Table.Th w={112} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row, i) => (
                  <Table.Tr key={row.key}>
                    <Table.Td>
                      <Text size="sm" fw={600} c="dimmed">
                        {i + 1}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        aria-label="type"
                        allowDeselect={false}
                        data={ITINERARY_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                        value={row.type}
                        onChange={(v) => setRow(row.key, { type: v ?? 'flight' })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput placeholder={row.type === 'flight' ? 'e.g. KHI' : row.type === 'hotel' ? 'Hotel name' : 'From'} {...cell(row, 'origin')} />
                    </Table.Td>
                    <Table.Td>
                      <TextInput placeholder={row.type === 'flight' ? 'e.g. DXB' : row.type === 'hotel' ? 'City' : 'To'} {...cell(row, 'destination')} />
                    </Table.Td>
                    <Table.Td>
                      <TextInput type="date" required {...cell(row, 'departure_date')} />
                    </Table.Td>
                    <Table.Td>
                      <TextInput type="time" {...cell(row, 'departure_time')} />
                    </Table.Td>
                    <Table.Td>
                      <TextInput type="date" min={row.departure_date || undefined} {...cell(row, 'arrival_date')} />
                    </Table.Td>
                    <Table.Td>
                      <TextInput type="time" {...cell(row, 'arrival_time')} />
                    </Table.Td>
                    <Table.Td>
                      <TextInput {...cell(row, 'confirmation_number')} />
                    </Table.Td>
                    <Table.Td>
                      <TextInput maxLength={20} styles={{ input: { textTransform: 'uppercase' } }} {...cell(row, 'gds_pnr', (v) => v.toUpperCase())} />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap">
                        <Tooltip label="Move up">
                          <ActionIcon variant="subtle" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                            <IconArrowUp size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Move down">
                          <ActionIcon variant="subtle" size="sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                            <IconArrowDown size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Duplicate">
                          <ActionIcon
                            variant="subtle"
                            size="sm"
                            aria-label="Duplicate"
                            onClick={() => setRows((all) => [...all.slice(0, i + 1), { ...row, key: nextKey++ }, ...all.slice(i + 1)])}
                          >
                            <IconCopy size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Remove">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            size="sm"
                            disabled={rows.length === 1}
                            aria-label="Remove"
                            onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>

        <Card withBorder>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label="Booking status"
              description="Upcoming, ongoing and completed follow from the dates"
              allowDeselect={false}
              data={TRIP_STATUSES.map((t) => ({ value: t.value, label: t.label }))}
              value={form.status}
              onChange={(v) => setForm((f) => ({ ...f, status: v ?? 'planned' }))}
            />
            <Textarea label="Notes" autosize minRows={2} {...field('notes')} />
          </SimpleGrid>
        </Card>

        <Text size="sm" c="dimmed">
          Tickets, hotel guests and documents can be added on the trip page after saving.
        </Text>
        <Group>
          <Button type="submit" loading={save.isPending}>
            {id ? 'Save changes' : 'Create trip'}
          </Button>
          <Button variant="default" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
