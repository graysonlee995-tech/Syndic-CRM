import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  SegmentedControl,
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
import { IconArrowDown, IconArrowUp, IconCopy, IconPlus, IconTicket, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import { useTravellerOptions } from '../components/ListKit';
import { CompanyPicker } from '../components/CompanyPicker';
import { TravellerPicker } from '../components/TravellerPicker';
import { TRIP_STATUSES, TRIP_TYPES, type ItineraryItem, type Trip, type TripDetail } from '../types';

/** One row in the form; every field is a string while editing. `credit`: travellers it becomes open credit for. */
type Row = { key: number; credit: number[] | null } & { [K in keyof ItineraryItem]: string };
type Field = Exclude<keyof ItineraryItem, 'type'>;

type SectionId = 'itinerary' | 'hotels' | 'cars' | 'others';

interface Column {
  field: Field;
  label: string;
  width?: number;
  kind?: 'date' | 'time' | 'upper' | 'textarea';
  /** The row's start date: needed once anything in the row is filled in. */
  required?: boolean;
  placeholder?: string | ((row: Row) => string);
  maxLength?: number;
}

interface Section {
  id: SectionId;
  title: string;
  hint: string;
  add: string;
  /** Types a row of this section can have; the first is the default. */
  types: string[];
  columns: Column[];
  minWidth: number;
}

const isTrain = (r: Row) => r.type === 'train';

const SECTIONS: Section[] = [
  {
    id: 'itinerary',
    title: 'Itinerary',
    hint: 'Flights and trains. The trip dates come from all sections.',
    add: 'Add flight/train',
    types: ['flight', 'train'],
    minWidth: 1550,
    columns: [
      { field: 'airline', label: 'Airline/Operator', width: 140, placeholder: (r) => (isTrain(r) ? 'e.g. Amtrak' : 'e.g. Emirates') },
      { field: 'flight_number', label: 'Flight/Train No.', width: 105, kind: 'upper', maxLength: 20, placeholder: (r) => (isTrain(r) ? 'e.g. 2150' : 'e.g. EK 601') },
      { field: 'origin', label: 'From', placeholder: (r) => (isTrain(r) ? 'e.g. New York Penn' : 'e.g. JFK') },
      { field: 'destination', label: 'To', placeholder: (r) => (isTrain(r) ? 'e.g. Boston South' : 'e.g. DXB') },
      { field: 'departure_date', label: 'Departure date', width: 140, kind: 'date', required: true },
      { field: 'departure_time', label: 'Dep. time', width: 105, kind: 'time' },
      { field: 'arrival_date', label: 'Arrival date', width: 140, kind: 'date' },
      { field: 'arrival_time', label: 'Arr. time', width: 105, kind: 'time' },
      { field: 'confirmation_number', label: 'A/L PNR', width: 120, kind: 'upper', maxLength: 50, placeholder: 'e.g. 8XK2P1' },
      { field: 'gds_pnr', label: 'GDS PNR/TKT No.', width: 150, kind: 'upper', maxLength: 30, placeholder: 'e.g. ABC123 or 176-2401234567' },
    ],
  },
  {
    id: 'hotels',
    title: 'Hotels',
    hint: 'One row per hotel stay.',
    add: 'Add hotel',
    types: ['hotel'],
    minWidth: 1000,
    columns: [
      { field: 'name', label: 'Hotel', placeholder: 'e.g. Hilton Midtown' },
      { field: 'destination', label: 'City', placeholder: 'e.g. New York' },
      { field: 'departure_date', label: 'Check-in date', width: 150, kind: 'date', required: true },
      { field: 'arrival_date', label: 'Check-out date', width: 150, kind: 'date' },
      { field: 'confirmation_number', label: 'Conf. No.', width: 140, placeholder: 'e.g. H-77812' },
    ],
  },
  {
    id: 'cars',
    title: 'Cars',
    hint: 'Rentals & Chauffeur Drives.',
    add: 'Add car',
    types: ['car'],
    minWidth: 1300,
    columns: [
      { field: 'name', label: 'Car company', width: 150, placeholder: 'e.g. Hertz' },
      { field: 'origin', label: 'Pick-up location', placeholder: 'e.g. JFK Terminal 4' },
      { field: 'departure_date', label: 'Pick-up date', width: 140, kind: 'date', required: true },
      { field: 'departure_time', label: 'Time', width: 105, kind: 'time' },
      { field: 'destination', label: 'Drop-off location', placeholder: 'e.g. Manhattan office' },
      { field: 'arrival_date', label: 'Drop-off date', width: 140, kind: 'date' },
      { field: 'arrival_time', label: 'Time', width: 105, kind: 'time' },
      { field: 'confirmation_number', label: 'Conf. No.', width: 130, placeholder: 'e.g. K9-55120' },
    ],
  },
  {
    id: 'others',
    title: 'Others',
    hint: 'Anything else: tours, events, transfers, cruises, insurance and so on.',
    add: 'Add other',
    types: ['other'],
    minWidth: 1300,
    columns: [
      { field: 'name', label: 'Description', kind: 'textarea', placeholder: 'e.g. City tour with guide, meet at hotel lobby' },
      { field: 'destination', label: 'Location', width: 160, placeholder: 'e.g. Times Square' },
      { field: 'departure_date', label: 'Start date', width: 140, kind: 'date', required: true },
      { field: 'departure_time', label: 'Start time', width: 105, kind: 'time' },
      { field: 'arrival_date', label: 'End date', width: 140, kind: 'date' },
      { field: 'arrival_time', label: 'End time', width: 105, kind: 'time' },
      { field: 'confirmation_number', label: 'Conf. No.', width: 130, placeholder: 'e.g. TOUR-1182' },
    ],
  },
];

/** Sections whose rows can be marked as open credit. */
const CREDIT_SECTIONS: SectionId[] = ['itinerary', 'hotels'];

const kindName = (row: Row) => (row.type === 'train' ? 'train' : row.type === 'hotel' ? 'hotel stay' : 'flight');

const sectionOf = (type: string): SectionId =>
  type === 'hotel' ? 'hotels' : type === 'car' ? 'cars' : type === 'other' ? 'others' : 'itinerary';

const FIELDS: Field[] = [
  'airline',
  'flight_number',
  'name',
  'origin',
  'destination',
  'departure_date',
  'departure_time',
  'arrival_date',
  'arrival_time',
  'confirmation_number',
  'gds_pnr',
];

let nextKey = 1;

const toRow = (item: Partial<ItineraryItem>): Row => ({
  key: nextKey++,
  credit: null,
  type: item.type ?? 'flight',
  ...(Object.fromEntries(FIELDS.map((f) => [f, item[f] ?? ''])) as Record<Field, string>),
});

/** A new row usually starts where the previous one ended. */
const blankRow = (section: Section, previous?: Row): Row => {
  const row = toRow({ type: previous?.type ?? section.types[0] });
  if (previous && section.id === 'itinerary') row.origin = previous.destination;
  if (previous) row.departure_date = previous.arrival_date || previous.departure_date;
  return row;
};

/** Rows nobody typed anything into are left out when saving. */
const isBlank = (row: Row) => FIELDS.every((f) => !row[f].trim());

type Rows = Record<SectionId, Row[]>;
const EMPTY_ROWS = (): Rows => ({ itinerary: [blankRow(SECTIONS[0])], hotels: [], cars: [], others: [] });

export function TripFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const travellerOptions = useTravellerOptions();

  const [form, setForm] = useState({
    name: '',
    company_id: params.get('companyId') ?? '',
    trip_type: 'business',
    status: 'active',
    notes: '',
  });
  const [travellerIds, setTravellerIds] = useState<string[]>(params.get('travellerId') ? [params.get('travellerId')!] : []);
  const [rows, setRows] = useState<Rows>(EMPTY_ROWS);
  /** The flight, train or hotel row whose open-credit travellers are being chosen. */
  const [creditRow, setCreditRow] = useState<{ section: SectionId; row: Row } | null>(null);

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
    const next: Rows = { itinerary: [], hotels: [], cars: [], others: [] };
    for (const item of d.itinerary) next[sectionOf(item.type)].push(toRow(item));
    if (!d.itinerary.length && !d.open_credits.length) {
      // Trips saved before the itinerary existed: start from their dates and first destination.
      next.others.push(toRow({ type: 'other', destination: d.destinations[0]?.city ?? null, departure_date: t.departure_date, arrival_date: t.return_date }));
    }
    setRows(next);
  }, [existing.data]);

  const travellerName = (tid: number) => {
    const t = travellerOptions.data?.find((x) => x.id === tid) ?? existing.data?.travellers.find((x) => x.id === tid);
    return t ? `${t.first_name} ${t.last_name}` : `#${tid}`;
  };

  const save = useMutation({
    mutationFn: () => {
      const onTrip = new Set(travellerIds.map(Number));
      const itinerary = SECTIONS.flatMap((s) => rows[s.id])
        .filter((r) => !isBlank(r))
        .map(({ key: _key, credit, ...row }) => {
          const ids = (credit ?? []).filter((c) => onTrip.has(c));
          // Hotels are by date only.
          const times = row.type === 'hotel' ? { departure_time: '', arrival_time: '' } : {};
          return { ...row, ...times, open_credit: ids.length ? { traveller_ids: ids } : null };
        });
      const body = {
        ...form,
        company_id: form.company_id ? Number(form.company_id) : null,
        traveller_ids: travellerIds.map(Number),
        itinerary,
      };
      return id ? api<{ trip: Trip }>(`/trips/${id}`, { method: 'PUT', body }) : api<{ trip: Trip }>('/trips', { body });
    },
    onSuccess: ({ trip }) => {
      // The same trip shows in the trips list, the company profile, each traveller's history and Open Credits.
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['trip', String(trip.id)] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['open-credits'] });
      const credits = SECTIONS.flatMap((s) => rows[s.id]).filter((r) => r.credit?.length).length;
      notifySuccess(
        `${id ? 'Trip updated' : `Trip ${trip.reference} created`}${credits ? `; ${credits} item${credits === 1 ? '' : 's'} moved to Open Credits` : ''}`,
      );
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

  const update = (section: SectionId, fn: (list: Row[]) => Row[]) => setRows((all) => ({ ...all, [section]: fn(all[section]) }));
  const setRow = (section: SectionId, key: number, patch: Partial<Row>) =>
    update(section, (list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (section: SectionId, index: number, by: number) =>
    update(section, (list) => {
      const next = [...list];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row);
      return next;
    });

  // Choosing a company keeps only its travellers on the trip.
  const setCompany = (company_id: string) => {
    setForm((f) => ({ ...f, company_id }));
    if (company_id && travellerOptions.data) {
      const own = new Set(travellerOptions.data.filter((t) => String(t.company_id) === company_id).map((t) => String(t.id)));
      setTravellerIds((ids) => ids.filter((tid) => own.has(tid)));
    }
  };

  const existingCredits = existing.data?.open_credits ?? [];
  const tripTravellerIds = travellerIds.map(Number);

  const renderSection = (section: Section) => {
    const list = rows[section.id];
    const showType = section.types.length > 1;
    return (
      <Card withBorder key={section.id}>
        <Group justify="space-between" mb="sm">
          <div>
            <Title order={4}>{section.title}</Title>
            <Text size="xs" c="dimmed">
              {section.hint}
            </Text>
          </div>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => update(section.id, (l) => [...l, blankRow(section, l.at(-1))])}>
            {section.add}
          </Button>
        </Group>
        {section.id === 'itinerary' && existingCredits.length > 0 && (
          <Text size="xs" c="dimmed" mb="xs">
            {existingCredits.length} item{existingCredits.length === 1 ? '' : 's'} from this trip {existingCredits.length === 1 ? 'is' : 'are'} under{' '}
            <Anchor component={Link} to={`/open-credits?status=all`} size="xs">
              Open Credits
            </Anchor>
            .
          </Text>
        )}
        {list.length === 0 ? (
          <Text size="sm" c="dimmed">
            None yet.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={section.minWidth}>
            <Table verticalSpacing={6} horizontalSpacing={6} withRowBorders={false}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={24} />
                  {showType && <Table.Th w={100}>Type</Table.Th>}
                  {section.columns.map((c) => (
                    <Table.Th key={c.field + c.label} w={c.width}>
                      {c.label}
                    </Table.Th>
                  ))}
                  <Table.Th w={CREDIT_SECTIONS.includes(section.id) ? 140 : 112} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((row, i) => (
                  <SectionRow
                    key={row.key}
                    section={section}
                    row={row}
                    index={i}
                    count={list.length}
                    showType={showType}
                    creditNames={row.credit?.filter((c) => tripTravellerIds.includes(c)).map(travellerName) ?? []}
                    onChange={(patch) => setRow(section.id, row.key, patch)}
                    onMove={(by) => move(section.id, i, by)}
                    onDuplicate={() => update(section.id, (l) => [...l.slice(0, i + 1), { ...row, key: nextKey++, credit: null }, ...l.slice(i + 1)])}
                    onRemove={() => update(section.id, (l) => l.filter((r) => r.key !== row.key))}
                    onCredit={() => setCreditRow({ section: section.id, row })}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Stack maw={1500}>
        <Group justify="space-between" align="center" wrap="wrap">
          <Title order={2}>{id ? `Edit trip ${existing.data?.trip.reference ?? ''}` : 'New trip'}</Title>
          <Group gap="xs">
            <Text size="sm" fw={500}>
              Status
            </Text>
            <SegmentedControl
              aria-label="Trip status"
              data={TRIP_STATUSES.map((t) => ({ value: t.value, label: t.label }))}
              value={form.status}
              onChange={(status) => setForm((f) => ({ ...f, status }))}
              color={form.status === 'active' ? 'green' : form.status === 'inactive' ? 'yellow' : 'red'}
            />
          </Group>
        </Group>

        <Card withBorder>
          <Title order={4} mb="sm">
            Trip
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            <TextInput label="Trip name" required placeholder="e.g. Europe Business Tour" {...field('name')} autoFocus />
            <CompanyPicker value={form.company_id} onChange={setCompany} placeholder="No company (private trip)" />
            <TravellerPicker value={travellerIds} onChange={setTravellerIds} companyId={form.company_id} />
            <Select
              label="Trip type"
              allowDeselect={false}
              data={TRIP_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              value={form.trip_type}
              onChange={(v) => setForm((f) => ({ ...f, trip_type: v ?? 'business' }))}
            />
          </SimpleGrid>
        </Card>

        {SECTIONS.map(renderSection)}

        <Card withBorder>
          <Textarea label="Notes" placeholder="Anything the team should know about this trip" autosize minRows={2} {...field('notes')} />
        </Card>

        <Text size="sm" c="dimmed">
          Tickets and documents can be added on the trip page after saving.
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

      <CreditModal
        row={creditRow?.row ?? null}
        travellerIds={tripTravellerIds}
        travellerName={travellerName}
        onClose={() => setCreditRow(null)}
        onSave={(credit) => {
          if (creditRow) setRow(creditRow.section, creditRow.row.key, { credit });
          setCreditRow(null);
        }}
      />
    </form>
  );
}

interface SectionRowProps {
  section: Section;
  row: Row;
  index: number;
  count: number;
  showType: boolean;
  creditNames: string[];
  onChange: (patch: Partial<Row>) => void;
  onMove: (by: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onCredit: () => void;
}

function SectionRow({ section, row, index, count, showType, creditNames, onChange, onMove, onDuplicate, onRemove, onCredit }: SectionRowProps) {
  const blank = isBlank(row);
  const isCredit = creditNames.length > 0;
  const columns = section.columns.length + (showType ? 1 : 0) + 2;

  const input = (c: Column) => {
    const common = {
      size: 'xs' as const,
      'aria-label': c.label,
      value: row[c.field],
      placeholder: typeof c.placeholder === 'function' ? c.placeholder(row) : c.placeholder,
      maxLength: c.maxLength,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { value } = e.currentTarget;
        onChange({ [c.field]: c.kind === 'upper' ? value.toUpperCase() : value });
      },
    };
    if (c.kind === 'textarea') return <Textarea {...common} autosize minRows={1} maxRows={4} />;
    return (
      <TextInput
        {...common}
        type={c.kind === 'date' ? 'date' : c.kind === 'time' ? 'time' : 'text'}
        required={c.required && !blank}
        min={c.field === 'arrival_date' ? row.departure_date || undefined : undefined}
        styles={c.kind === 'upper' ? { input: { textTransform: 'uppercase' } } : undefined}
      />
    );
  };

  return (
    <>
      <Table.Tr style={isCredit ? { background: 'var(--mantine-color-orange-light)' } : undefined}>
        <Table.Td>
          <Text size="sm" fw={600} c="dimmed">
            {index + 1}
          </Text>
        </Table.Td>
        {showType && (
          <Table.Td>
            <Select
              size="xs"
              aria-label="Type"
              allowDeselect={false}
              data={section.types.map((t) => ({ value: t, label: t === 'train' ? 'Train' : 'Flight' }))}
              value={row.type}
              onChange={(v) => onChange({ type: v ?? section.types[0] })}
            />
          </Table.Td>
        )}
        {section.columns.map((c) => (
          <Table.Td key={c.field + c.label}>{input(c)}</Table.Td>
        ))}
        <Table.Td>
          <Group gap={2} wrap="nowrap" justify="flex-end">
            <Tooltip label="Move up">
              <ActionIcon variant="subtle" size="sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
                <IconArrowUp size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Move down">
              <ActionIcon variant="subtle" size="sm" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">
                <IconArrowDown size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Duplicate">
              <ActionIcon variant="subtle" size="sm" aria-label="Duplicate" onClick={onDuplicate}>
                <IconCopy size={14} />
              </ActionIcon>
            </Tooltip>
            {CREDIT_SECTIONS.includes(section.id) && (
              <Tooltip label={isCredit ? 'Change open credit' : 'Mark as open credit'}>
                <ActionIcon
                  variant={isCredit ? 'filled' : 'subtle'}
                  color="orange"
                  size="sm"
                  aria-label="Open credit"
                  onClick={onCredit}
                >
                  <IconTicket size={14} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="Remove">
              <ActionIcon variant="subtle" color="red" size="sm" aria-label="Remove" onClick={onRemove}>
                <IconTrash size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
      {isCredit && (
        <Table.Tr style={{ background: 'var(--mantine-color-orange-light)' }}>
          <Table.Td />
          <Table.Td colSpan={columns - 1} pt={0}>
            <Group gap="xs">
              <Badge color="orange" variant="filled" leftSection={<IconTicket size={12} />}>
                Open credit
              </Badge>
              <Text size="xs">
                For {creditNames.join(', ')}. This {kindName(row)} moves to Open Credits when you save the trip.
              </Text>
              <Anchor component="button" type="button" size="xs" onClick={() => onChange({ credit: null })}>
                Undo
              </Anchor>
            </Group>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

interface CreditModalProps {
  row: Row | null;
  travellerIds: number[];
  travellerName: (id: number) => string;
  onClose: () => void;
  onSave: (credit: number[] | null) => void;
}

/** Picks the travellers a flight, train or hotel stay becomes open credit for. */
function CreditModal({ row, travellerIds, travellerName, onClose, onSave }: CreditModalProps) {
  const [chosen, setChosen] = useState<string[]>([]);
  const onTrip = travellerIds.join(',');
  // Starts from the row's current choice, or everyone on the trip.
  useEffect(() => {
    if (row) setChosen((row.credit?.length ? row.credit : travellerIds).filter((c) => travellerIds.includes(c)).map(String));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, onTrip]);

  const isHotel = row?.type === 'hotel';
  const what = row
    ? (isHotel ? row.name : [row.airline, row.flight_number].filter(Boolean).join(' ')) || (isHotel ? 'Hotel' : row.type === 'train' ? 'Train' : 'Flight')
    : '';
  const route = row ? (isHotel ? row.destination : [row.origin, row.destination].filter(Boolean).join(' → ')) : '';

  return (
    <Modal opened={Boolean(row)} onClose={onClose} title="Mark as open credit">
      <Stack>
        <Text size="sm">
          <b>{what}</b>
          {route ? ` · ${route}` : ''}
          {row?.departure_date ? ` · ${row.departure_date}` : ''}
        </Text>
        {travellerIds.length === 0 ? (
          <Alert color="orange">Add the trip's travellers first, then choose who this credit is for.</Alert>
        ) : (
          <Checkbox.Group label="Open credit for" description="Each one gets their own entry under Open Credits." value={chosen} onChange={setChosen}>
            <Stack gap={6} mt="xs">
              {travellerIds.map((t) => (
                <Checkbox key={t} value={String(t)} label={travellerName(t)} />
              ))}
            </Stack>
          </Checkbox.Group>
        )}
        <Text size="xs" c="dimmed">
          When the trip is saved, the whole row moves from the trip to Open Credits.
        </Text>
        <Group justify="flex-end">
          {row?.credit?.length ? (
            <Button variant="subtle" color="red" onClick={() => onSave(null)}>
              Not open credit
            </Button>
          ) : null}
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="orange" disabled={!chosen.length || !row?.departure_date} onClick={() => onSave(chosen.map(Number))}>
            Mark as open credit
          </Button>
        </Group>
        {row && !row.departure_date && (
          <Text size="xs" c="red">
            Enter the {isHotel ? 'check-in' : 'departure'} date first.
          </Text>
        )}
      </Stack>
    </Modal>
  );
}
