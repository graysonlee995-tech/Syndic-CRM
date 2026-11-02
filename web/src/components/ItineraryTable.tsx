import { Badge, Stack, Table, Text, Title } from '@mantine/core';
import { formatDate } from '../format';
import type { ItineraryItem } from '../types';

type Item = ItineraryItem & { id: number };

const when = (date: string | null, time: string | null) => (date ? `${formatDate(date)}${time ? `, ${time}` : ''}` : '-');
const text = (v: string | null) => v || '-';

interface Column {
  label: string;
  render: (i: Item) => React.ReactNode;
  nowrap?: boolean;
}

/** The trip form's sections, in the same order, each with its own columns. */
const SECTIONS: { title: string; types: string[]; columns: Column[] }[] = [
  {
    title: 'Itinerary',
    types: ['flight', 'train'],
    columns: [
      {
        label: 'Type',
        render: (i) => (
          <Badge variant="light" color={i.type === 'train' ? 'indigo' : 'blue'}>
            {i.type === 'train' ? 'Train' : 'Flight'}
          </Badge>
        ),
      },
      { label: 'Airline/Operator', render: (i) => text(i.airline) },
      { label: 'Flight/Train No.', render: (i) => text(i.flight_number), nowrap: true },
      { label: 'From', render: (i) => <Text fw={500} size="sm">{text(i.origin)}</Text> },
      { label: 'To', render: (i) => <Text fw={500} size="sm">{text(i.destination)}</Text> },
      { label: 'Departure', render: (i) => when(i.departure_date, i.departure_time), nowrap: true },
      { label: 'Arrival', render: (i) => when(i.arrival_date, i.arrival_time), nowrap: true },
      { label: 'A/L PNR', render: (i) => text(i.confirmation_number) },
      { label: 'GDS PNR/TKT No.', render: (i) => <Text ff="monospace" size="sm">{text(i.gds_pnr)}</Text> },
    ],
  },
  {
    title: 'Hotels',
    types: ['hotel'],
    columns: [
      { label: 'Hotel', render: (i) => <Text fw={500} size="sm">{text(i.name)}</Text> },
      { label: 'City', render: (i) => text(i.destination) },
      { label: 'Check-in', render: (i) => when(i.departure_date, null), nowrap: true },
      { label: 'Check-out', render: (i) => when(i.arrival_date, null), nowrap: true },
      { label: 'Conf. No.', render: (i) => text(i.confirmation_number) },
    ],
  },
  {
    title: 'Cars',
    types: ['car'],
    columns: [
      { label: 'Car company', render: (i) => <Text fw={500} size="sm">{text(i.name)}</Text> },
      { label: 'Pick-up', render: (i) => text(i.origin) },
      { label: 'Pick-up time', render: (i) => when(i.departure_date, i.departure_time), nowrap: true },
      { label: 'Drop-off', render: (i) => text(i.destination) },
      { label: 'Drop-off time', render: (i) => when(i.arrival_date, i.arrival_time), nowrap: true },
      { label: 'Conf. No.', render: (i) => text(i.confirmation_number) },
    ],
  },
  {
    title: 'Others',
    types: ['other'],
    columns: [
      { label: 'Description', render: (i) => <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{text(i.name)}</Text> },
      { label: 'Location', render: (i) => text(i.destination) },
      { label: 'Start', render: (i) => when(i.departure_date, i.departure_time), nowrap: true },
      { label: 'End', render: (i) => when(i.arrival_date, i.arrival_time), nowrap: true },
      { label: 'Conf. No.', render: (i) => text(i.confirmation_number) },
    ],
  },
];

/** A trip's itinerary (flights and trains), hotels, cars and others, each in the order entered. */
export function ItineraryTable({ items }: { items: Item[] }) {
  if (!items.length) {
    return (
      <Text c="dimmed" size="sm">
        Nothing yet. Use Edit to add flights, trains, hotels, cars and others.
      </Text>
    );
  }
  return (
    <Stack gap="lg">
      {SECTIONS.map((section) => {
        const rows = items.filter((i) => section.types.includes(i.type));
        if (!rows.length) return null;
        return (
          <div key={section.title}>
            <Title order={6} mb={4}>
              {section.title} ({rows.length})
            </Title>
            <Table.ScrollContainer minWidth={section.columns.length > 6 ? 1000 : 720}>
              <Table verticalSpacing="xs" striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={30}>#</Table.Th>
                    {section.columns.map((c) => (
                      <Table.Th key={c.label}>{c.label}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((i, n) => (
                    <Table.Tr key={i.id}>
                      <Table.Td c="dimmed">{n + 1}</Table.Td>
                      {section.columns.map((c) => (
                        <Table.Td key={c.label} style={c.nowrap ? { whiteSpace: 'nowrap' } : undefined}>
                          {c.render(i)}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </div>
        );
      })}
    </Stack>
  );
}
