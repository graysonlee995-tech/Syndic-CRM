import { Badge, Table, Text } from '@mantine/core';
import { formatDate, labelOf } from '../format';
import { ITINERARY_TYPES, type ItineraryItem } from '../types';

const TYPE_COLORS: Record<string, string> = {
  flight: 'blue',
  hotel: 'grape',
  car: 'orange',
  cruise: 'cyan',
  train: 'indigo',
  transfer: 'yellow',
  other: 'gray',
};

const when = (date: string | null, time: string | null) => (date ? `${formatDate(date)}${time ? `, ${time}` : ''}` : '-');

/** A trip's itinerary, in the order it was entered. */
export function ItineraryTable({ items }: { items: (ItineraryItem & { id: number })[] }) {
  if (!items.length) {
    return (
      <Text c="dimmed" size="sm">
        No itinerary yet. Use Edit to add flights, hotels and cars.
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={900}>
      <Table verticalSpacing="xs" striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={30}>#</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Origin</Table.Th>
            <Table.Th>Destination</Table.Th>
            <Table.Th>Departure</Table.Th>
            <Table.Th>Arrival</Table.Th>
            <Table.Th>Conf. No.</Table.Th>
            <Table.Th>GDS PNR</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((i, n) => (
            <Table.Tr key={i.id}>
              <Table.Td c="dimmed">{n + 1}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={TYPE_COLORS[i.type] ?? 'gray'}>
                  {labelOf(ITINERARY_TYPES, i.type)}
                </Badge>
              </Table.Td>
              <Table.Td fw={500}>{i.origin ?? '-'}</Table.Td>
              <Table.Td fw={500}>{i.destination ?? '-'}</Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{when(i.departure_date, i.departure_time)}</Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{when(i.arrival_date, i.arrival_time)}</Table.Td>
              <Table.Td>{i.confirmation_number ?? '-'}</Table.Td>
              <Table.Td ff="monospace">{i.gds_pnr ?? '-'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
