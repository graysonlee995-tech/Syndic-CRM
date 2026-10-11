import { useState } from 'react';
import { Anchor, Badge, Card, Group, Loader, SegmentedControl, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCake, IconClockHour4, IconFiles, IconPlaneDeparture, IconUsersGroup } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ExpiryBadge, formatDate } from '../format';
import { documentLabel, type ExpiringDocument, type UpcomingBirthday } from '../types';

interface Dashboard {
  today: string;
  totals: { clients: number; documents: number; upcomingTrips: number };
  counts: { expired: number; within7: number; within30: number; within90: number };
  documents: ExpiringDocument[];
  birthdays: UpcomingBirthday[];
}

function BirthdaysCard({ birthdays }: { birthdays: UpcomingBirthday[] }) {
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm">
        <IconCake size={20} color="var(--mantine-color-pink-6)" />
        <Title order={4}>Upcoming birthdays</Title>
        <Text size="sm" c="dimmed">
          next 30 days
        </Text>
      </Group>
      {birthdays.length === 0 ? (
        <Text c="dimmed" size="sm">
          No traveller birthdays in the next 30 days.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={500}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Traveller</Table.Th>
                <Table.Th>Birthday</Table.Th>
                <Table.Th>Turns</Table.Th>
                <Table.Th>Phone</Table.Th>
                <Table.Th>When</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {birthdays.map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>
                    <Anchor component={Link} to={`/travellers/${b.id}`}>
                      {b.first_name} {b.last_name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{formatDate(b.date)}</Table.Td>
                  <Table.Td>{b.age}</Table.Td>
                  <Table.Td>{b.phone ?? '-'}</Table.Td>
                  <Table.Td>
                    <Badge
                      color="pink"
                      variant={b.days_until === 0 ? 'filled' : 'light'}
                      style={{ minWidth: 'max-content' }}
                    >
                      {b.days_until === 0 ? 'Today' : b.days_until === 1 ? 'Tomorrow' : `In ${b.days_until} days`}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

const FILTERS = {
  all: () => true,
  expired: (d: ExpiringDocument) => d.days_left < 0,
  '7': (d: ExpiringDocument) => d.days_left >= 0 && d.days_left <= 7,
  '30': (d: ExpiringDocument) => d.days_left >= 0 && d.days_left <= 30,
  '90': (d: ExpiringDocument) => d.days_left >= 0,
};

function Stat({ label, value, color, icon: Icon }: { label: string; value: number; color: string; icon: typeof IconFiles }) {
  return (
    <Card withBorder padding="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            {label}
          </Text>
          <Text fz={28} fw={700} c={value > 0 ? color : undefined}>
            {value}
          </Text>
        </div>
        <Icon size={22} color={`var(--mantine-color-${color}-6)`} />
      </Group>
    </Card>
  );
}

export function DashboardPage() {
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard') });

  if (isLoading || !data) return <Loader />;
  const rows = data.documents.filter(FILTERS[filter]);

  return (
    <Stack>
      <Title order={2}>Dashboard</Title>
      <SimpleGrid cols={{ base: 2, md: 4, lg: 7 }}>
        <Stat label="Upcoming trips" value={data.totals.upcomingTrips} color="blue" icon={IconPlaneDeparture} />
        <Stat label="Travellers" value={data.totals.clients} color="teal" icon={IconUsersGroup} />
        <Stat label="Documents" value={data.totals.documents} color="teal" icon={IconFiles} />
        <Stat label="Expired" value={data.counts.expired} color="red" icon={IconAlertTriangle} />
        <Stat label="Next 7 days" value={data.counts.within7} color="red" icon={IconClockHour4} />
        <Stat label="Next 30 days" value={data.counts.within30} color="orange" icon={IconClockHour4} />
        <Stat label="Next 90 days" value={data.counts.within90} color="yellow" icon={IconClockHour4} />
      </SimpleGrid>

      <Card withBorder>
        <Group justify="space-between" mb="sm" wrap="wrap">
          <Title order={4}>Documents needing attention</Title>
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v as keyof typeof FILTERS)}
            data={[
              { value: 'all', label: 'All' },
              { value: 'expired', label: 'Expired' },
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
            ]}
          />
        </Group>
        {rows.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing here. No documents in this range.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={600}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Traveller</Table.Th>
                  <Table.Th>Document</Table.Th>
                  <Table.Th>Number</Table.Th>
                  <Table.Th>Expiry date</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/travellers/${d.client_id}`}>
                        {d.first_name} {d.last_name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{documentLabel(d.type)}</Table.Td>
                    <Table.Td>{d.document_number ?? '-'}</Table.Td>
                    <Table.Td>{formatDate(d.expiry_date)}</Table.Td>
                    <Table.Td>
                      <ExpiryBadge date={d.expiry_date} daysLeft={d.days_left} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <BirthdaysCard birthdays={data.birthdays} />
    </Stack>
  );
}
