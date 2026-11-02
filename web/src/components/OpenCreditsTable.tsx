import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Menu, Modal, Stack, Table, Text, Textarea, Tooltip } from '@mantine/core';
import { IconArrowBackUp, IconDots, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient, useMe } from '../api';
import { formatDate, formatTimestamp, labelOf } from '../format';
import { CREDIT_STATUSES, type OpenCredit } from '../types';

export const CREDIT_COLORS: Record<string, string> = { open: 'orange', used: 'gray', refunded: 'grape', expired: 'red' };

const when = (date: string | null, time: string | null) => (date ? `${formatDate(date)}${time ? `, ${time}` : ''}` : '-');

/** Rows of open credits; `showTrip` / `showCompany` hide columns that a trip page already makes obvious. */
export function OpenCreditsTable({ credits, showTrip = true, showCompany = true }: { credits: OpenCredit[]; showTrip?: boolean; showCompany?: boolean }) {
  const me = useMe();
  const [changing, setChanging] = useState<{ credit: OpenCredit; status: string } | null>(null);
  const [notes, setNotes] = useState('');

  const refresh = (tripId: number) => {
    queryClient.invalidateQueries({ queryKey: ['open-credits'] });
    queryClient.invalidateQueries({ queryKey: ['trip', String(tripId)] });
  };

  const setStatus = useMutation({
    mutationFn: ({ credit, status }: { credit: OpenCredit; status: string }) =>
      api(`/open-credits/${credit.id}/status`, { method: 'PUT', body: { status, notes } }),
    onSuccess: (_r, { credit, status }) => {
      refresh(credit.trip_id);
      notifySuccess(`Marked ${labelOf(CREDIT_STATUSES, status).toLowerCase()}`);
      setChanging(null);
    },
    onError: notifyError,
  });

  const moveBack = useMutation({
    mutationFn: (credit: OpenCredit) => api<{ removed: number }>(`/open-credits/${credit.id}/move-back`, { method: 'POST' }),
    onSuccess: (r, credit) => {
      refresh(credit.trip_id);
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      notifySuccess(`Moved back to ${credit.trip_reference}${r.removed > 1 ? ` (${r.removed} travellers' credits removed)` : ''}`);
    },
    onError: notifyError,
  });

  const remove = useMutation({
    mutationFn: (credit: OpenCredit) => api(`/open-credits/${credit.id}`, { method: 'DELETE' }),
    onSuccess: (_r, credit) => {
      refresh(credit.trip_id);
      notifySuccess('Open credit removed');
    },
    onError: notifyError,
  });

  const open = (credit: OpenCredit, status: string) => {
    setNotes(credit.notes ?? '');
    setChanging({ credit, status });
  };

  return (
    <>
      <Table.ScrollContainer minWidth={1150}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {showCompany && <Table.Th>Company</Table.Th>}
              <Table.Th>Traveller</Table.Th>
              {showTrip && <Table.Th>Trip</Table.Th>}
              <Table.Th>Booking</Table.Th>
              <Table.Th>Route/City</Table.Th>
              <Table.Th>Departure/Check-in</Table.Th>
              <Table.Th>A/L PNR/GDS PNR</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th w={60} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {credits.map((c) => (
              <Table.Tr key={c.id}>
                {showCompany && (
                  <Table.Td>
                    {c.company_id ? (
                      <Anchor component={Link} to={`/companies/${c.company_id}`} size="sm">
                        {c.company_name}
                      </Anchor>
                    ) : (
                      <Text size="sm" c="dimmed">
                        Private
                      </Text>
                    )}
                  </Table.Td>
                )}
                <Table.Td>
                  <Anchor component={Link} to={`/travellers/${c.client_id}`} size="sm" fw={500}>
                    {c.first_name} {c.last_name}
                  </Anchor>
                </Table.Td>
                {showTrip && (
                  <Table.Td>
                    <Anchor component={Link} to={`/trips/${c.trip_id}`} size="sm">
                      {c.trip_reference}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {c.trip_name}
                    </Text>
                  </Table.Td>
                )}
                <Table.Td>
                  <Badge variant="light" color={c.type === 'train' ? 'indigo' : c.type === 'hotel' ? 'grape' : 'blue'} mr={6}>
                    {c.type === 'train' ? 'Train' : c.type === 'hotel' ? 'Hotel' : 'Flight'}
                  </Badge>
                  <Text span size="sm">
                    {(c.type === 'hotel' ? c.name : [c.airline, c.flight_number].filter(Boolean).join(' ')) || '-'}
                  </Text>
                </Table.Td>
                <Table.Td fw={500}>{(c.type === 'hotel' ? c.destination : [c.origin, c.destination].filter(Boolean).join(' → ')) || '-'}</Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>
                  {c.type === 'hotel' ? `${when(c.departure_date, null)}${c.arrival_date ? ` → ${formatDate(c.arrival_date)}` : ''}` : when(c.departure_date, c.departure_time)}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{c.confirmation_number ?? '-'}</Text>
                  {c.gds_pnr && (
                    <Text size="xs" ff="monospace" c="dimmed">
                      {c.gds_pnr}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge color={CREDIT_COLORS[c.status] ?? 'gray'} variant={c.status === 'open' ? 'filled' : 'light'}>
                    {labelOf(CREDIT_STATUSES, c.status)}
                  </Badge>
                  {c.status !== 'open' && c.resolved_at && (
                    <Text size="xs" c="dimmed">
                      {formatTimestamp(c.resolved_at)}
                      {c.resolved_by_name ? ` · ${c.resolved_by_name}` : ''}
                    </Text>
                  )}
                  {c.notes && (
                    <Text size="xs" c="dimmed" maw={220}>
                      {c.notes}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={2} wrap="nowrap">
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon variant="subtle" aria-label="Change status">
                          <IconDots size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {CREDIT_STATUSES.filter((s) => s.value !== c.status).map((s) => (
                          <Menu.Item key={s.value} onClick={() => open(c, s.value)}>
                            {s.value === 'open' ? 'Open again' : `Mark ${s.label.toLowerCase()}`}
                          </Menu.Item>
                        ))}
                        {me.data?.role === 'admin' && (
                          <>
                            <Menu.Divider />
                            <Menu.Item
                              leftSection={<IconArrowBackUp size={14} />}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Move this ${c.type === 'hotel' ? 'hotel' : c.type} back to ${c.trip_reference}? ` +
                                      "It returns to the trip as it was, and the open credits made from it for all travellers are removed. The trip's quality check will need to be done again.",
                                  )
                                )
                                  moveBack.mutate(c);
                              }}
                            >
                              Move back to trip
                            </Menu.Item>
                          </>
                        )}
                      </Menu.Dropdown>
                    </Menu>
                    {me.data?.role === 'admin' && (
                      <Tooltip label="Delete (entered by mistake)">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label="Delete open credit"
                          onClick={() => {
                            if (window.confirm(`Delete this open credit for ${c.first_name} ${c.last_name}? This cannot be undone.`)) remove.mutate(c);
                          }}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal
        opened={Boolean(changing)}
        onClose={() => setChanging(null)}
        title={changing ? (changing.status === 'open' ? 'Open the credit again' : `Mark credit ${labelOf(CREDIT_STATUSES, changing.status).toLowerCase()}`) : ''}
      >
        {changing && (
          <Stack>
            <Text size="sm">
              {changing.credit.first_name} {changing.credit.last_name} ·{' '}
              {(changing.credit.type === 'hotel' ? changing.credit.name : [changing.credit.airline, changing.credit.flight_number].filter(Boolean).join(' ')) || changing.credit.type}{' '}
              {[changing.credit.origin, changing.credit.destination].filter(Boolean).join(' → ')}
            </Text>
            <Textarea
              label="Notes"
              placeholder="e.g. Used for TRP-2026-00031, or refunded to the company card"
              autosize
              minRows={2}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setChanging(null)}>
                Cancel
              </Button>
              <Button loading={setStatus.isPending} onClick={() => setStatus.mutate(changing)}>
                Save
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
