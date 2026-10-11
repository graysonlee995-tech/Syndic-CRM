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
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import { useCompanyOptions, useTravellerOptions } from '../components/ListKit';
import { TRIP_STATUSES, TRIP_TYPES, type Trip, type TripDetail } from '../types';

interface DestinationRow {
  key: number;
  city: string;
  country: string;
  arrival_date: string;
  departure_date: string;
  notes: string;
}

let nextKey = 1;
const blankDestination = (): DestinationRow => ({ key: nextKey++, city: '', country: '', arrival_date: '', departure_date: '', notes: '' });

export function TripFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const companies = useCompanyOptions();
  const travellerOptions = useTravellerOptions();

  const [form, setForm] = useState({
    name: '',
    company_id: params.get('companyId') ?? '',
    origin: '',
    departure_date: '',
    return_date: '',
    trip_type: 'business',
    status: 'planned',
    notes: '',
  });
  const [travellerIds, setTravellerIds] = useState<string[]>(params.get('travellerId') ? [params.get('travellerId')!] : []);
  const [destinations, setDestinations] = useState<DestinationRow[]>([blankDestination()]);

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
      origin: t.origin ?? '',
      departure_date: t.departure_date,
      return_date: t.return_date ?? '',
      trip_type: t.trip_type,
      status: t.status,
      notes: t.notes ?? '',
    });
    setTravellerIds(d.travellers.map((c) => String(c.id)));
    setDestinations(
      d.destinations.length
        ? d.destinations.map((s) => ({
            key: nextKey++,
            city: s.city,
            country: s.country ?? '',
            arrival_date: s.arrival_date ?? '',
            departure_date: s.departure_date ?? '',
            notes: s.notes ?? '',
          }))
        : [blankDestination()],
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
        destinations: destinations.filter((d) => d.city.trim()).map(({ key: _key, ...d }) => d),
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

  const setDestination = (key: number, patch: Partial<DestinationRow>) =>
    setDestinations((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const moveDestination = (index: number, by: number) =>
    setDestinations((rows) => {
      const next = [...rows];
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
      <Stack maw={1000}>
        <Title order={2}>{id ? `Edit trip ${existing.data?.trip.reference ?? ''}` : 'New trip'}</Title>

        <Card withBorder>
          <Stack>
            <TextInput label="Trip name" required placeholder="e.g. Europe Business Tour" {...field('name')} autoFocus />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label="Company"
                placeholder="No company (private trip)"
                clearable
                searchable
                data={companies.data ?? []}
                value={form.company_id || null}
                onChange={(v) => setForm((f) => ({ ...f, company_id: v ?? '' }))}
              />
              <TextInput label="Origin" placeholder="e.g. Karachi" {...field('origin')} />
              <TextInput label="Departure date" type="date" required {...field('departure_date')} />
              <TextInput label="Return / end date" type="date" min={form.departure_date || undefined} {...field('return_date')} />
              <Select
                label="Trip type"
                allowDeselect={false}
                data={TRIP_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                value={form.trip_type}
                onChange={(v) => setForm((f) => ({ ...f, trip_type: v ?? 'business' }))}
              />
              <Select
                label="Booking status"
                description="Upcoming, ongoing and completed follow from the dates"
                allowDeselect={false}
                data={TRIP_STATUSES.map((t) => ({ value: t.value, label: t.label }))}
                value={form.status}
                onChange={(v) => setForm((f) => ({ ...f, status: v ?? 'planned' }))}
              />
            </SimpleGrid>
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
            <Textarea label="Notes" autosize minRows={2} {...field('notes')} />
          </Stack>
        </Card>

        <Card withBorder>
          <Group justify="space-between" mb="sm">
            <Title order={4}>Destinations</Title>
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setDestinations((d) => [...d, blankDestination()])}>
              Add destination
            </Button>
          </Group>
          <Stack gap="sm">
            {destinations.map((d, i) => (
              <Group key={d.key} align="flex-end" wrap="wrap" gap="xs">
                <Text fw={600} w={20}>
                  {i + 1}.
                </Text>
                <TextInput label="City" value={d.city} onChange={(e) => setDestination(d.key, { city: e.currentTarget.value })} style={{ flex: '1 1 140px' }} />
                <TextInput label="Country" value={d.country} onChange={(e) => setDestination(d.key, { country: e.currentTarget.value })} style={{ flex: '1 1 120px' }} />
                <TextInput label="Arrive" type="date" value={d.arrival_date} onChange={(e) => setDestination(d.key, { arrival_date: e.currentTarget.value })} style={{ flex: '1 1 140px' }} />
                <TextInput label="Leave" type="date" value={d.departure_date} onChange={(e) => setDestination(d.key, { departure_date: e.currentTarget.value })} style={{ flex: '1 1 140px' }} />
                <Group gap={2} wrap="nowrap">
                  <ActionIcon variant="default" disabled={i === 0} onClick={() => moveDestination(i, -1)} aria-label="Move up" size="lg">
                    <IconArrowUp size={16} />
                  </ActionIcon>
                  <ActionIcon variant="default" disabled={i === destinations.length - 1} onClick={() => moveDestination(i, 1)} aria-label="Move down" size="lg">
                    <IconArrowDown size={16} />
                  </ActionIcon>
                  <ActionIcon variant="light" color="red" onClick={() => setDestinations((rows) => rows.filter((r) => r.key !== d.key))} aria-label="Remove destination" size="lg">
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
            ))}
            {destinations.length === 0 && (
              <Text c="dimmed" size="sm">
                No destinations.
              </Text>
            )}
          </Stack>
        </Card>

        <Text size="sm" c="dimmed">
          Flights, hotels, cars, cruises and documents are added on the trip page after saving.
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
