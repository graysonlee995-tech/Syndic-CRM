import { useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconEdit, IconEye, IconFileTypePdf, IconPlus, IconTicket, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient, useMe } from '../api';
import { ActivityHistory } from '../components/ActivityHistory';
import { BookingModal } from '../components/BookingModal';
import { BOOKING_DEFS, BOOKING_KINDS, type BookingKind } from '../components/bookings';
import { Field } from '../components/Field';
import { DocumentUploadModal, FileViewer, ResolveTicketModal, TicketModal } from '../components/TripModals';
import { ExpiryBadge, formatDate, formatDateTime, formatSize, formatTimestamp, labelOf, TripStatusBadge, travellerCode } from '../format';
import { TICKET_STATUSES, TRIP_TYPES, type Booking, type Flight, type Ticket, type TripDetail, type TripDocument } from '../types';

const TICKET_COLORS: Record<string, string> = { open: 'orange', issued: 'blue', used: 'gray', refunded: 'grape', exchanged: 'cyan', void: 'red' };

export function TripDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [bookingModal, setBookingModal] = useState<{ kind: BookingKind; booking: Booking | null } | null>(null);
  const [ticketModal, setTicketModal] = useState<{ flightId: number | null; ticket: Ticket | null } | null>(null);
  const [resolving, setResolving] = useState<Ticket | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewing, setViewing] = useState<TripDocument | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['trip', id],
    queryFn: () => api<TripDetail>(`/trips/${id}`),
  });

  /** One trip record feeds the trips list, the company profile and each traveller's history. */
  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['trip', id] });
    queryClient.invalidateQueries({ queryKey: ['trips'] });
    queryClient.invalidateQueries({ queryKey: ['activity', 'trip', Number(id)] });
  }

  const remove = useMutation({
    mutationFn: (path: string) => api(`/trips/${id}/${path}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notifySuccess('Removed');
    },
    onError: notifyError,
  });

  const trash = useMutation({
    mutationFn: () => api(`/trips/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      notifySuccess('Trip moved to the trash');
      navigate('/trips', { replace: true });
    },
    onError: notifyError,
  });

  if (isLoading) return <Loader />;
  if (error || !data) return <Text c="red">{(error as Error)?.message ?? 'Trip not found'}</Text>;
  const { trip, travellers, destinations, flights, documents } = data;
  const openTickets = flights.flatMap((f) => f.tickets).filter((k) => k.status === 'open').length;
  const confirmRemove = (what: string, path: string) => confirm(`Remove this ${what}?`) && remove.mutate(path);

  const bookingRows = (kind: BookingKind) => {
    const def = BOOKING_DEFS[kind];
    const rows = data[kind] as (Booking | Flight)[];
    return (
      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Title order={4}>{def.plural}</Title>
          <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setBookingModal({ kind, booking: null })}>
            Add {def.singular.toLowerCase()}
          </Button>
        </Group>
        {rows.length === 0 ? (
          <Text c="dimmed" size="sm">
            No {def.plural.toLowerCase()} yet.
          </Text>
        ) : (
          <Stack gap="sm">
            {rows.map((b) => {
              const [from, to] = def.when(b);
              const people = (b.traveller_ids ?? [])
                .map((tid) => travellers.find((t) => t.id === tid))
                .filter(Boolean)
                .map((t) => `${t!.first_name} ${t!.last_name}`);
              return (
                <Card key={b.id} withBorder padding="sm" radius="sm">
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <Stack gap={2}>
                      <Text fw={600}>{def.title(b)}</Text>
                      <Text size="sm" c="dimmed">
                        {formatDateTime(from)} → {formatDateTime(to)}
                      </Text>
                      <Group gap="lg" mt={4}>
                        {def.fields
                          .filter((f) => f.type !== 'textarea' && f.type !== 'date' && f.type !== 'datetime')
                          .filter((f) => b[f.key] && !def.title(b).includes(String(b[f.key])))
                          .map((f) => (
                            <Text key={f.key} size="sm">
                              <Text span c="dimmed" size="sm">
                                {f.label}:
                              </Text>{' '}
                              {String(b[f.key])}
                            </Text>
                          ))}
                      </Group>
                      {def.people && (
                        <Text size="sm">
                          <Text span c="dimmed" size="sm">
                            {def.people}:
                          </Text>{' '}
                          {people.join(', ') || '-'}
                        </Text>
                      )}
                      {typeof b.notes === 'string' && b.notes && (
                        <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                          {b.notes}
                        </Text>
                      )}
                    </Stack>
                    <Group gap={4} wrap="nowrap">
                      {kind === 'flights' && (
                        <Tooltip label="Add ticket">
                          <ActionIcon variant="light" aria-label="Add ticket" onClick={() => setTicketModal({ flightId: b.id, ticket: null })}>
                            <IconTicket size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      <ActionIcon variant="default" aria-label={`Edit ${def.singular}`} onClick={() => setBookingModal({ kind, booking: b })}>
                        <IconEdit size={16} />
                      </ActionIcon>
                      <ActionIcon variant="light" color="red" aria-label={`Remove ${def.singular}`} onClick={() => confirmRemove(def.singular.toLowerCase(), `${kind}/${b.id}`)}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Group>

                  {kind === 'flights' && (b as Flight).tickets.length > 0 && (
                    <Table.ScrollContainer minWidth={560} mt="sm">
                      <Table verticalSpacing={4} fz="sm">
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Traveller</Table.Th>
                            <Table.Th>Ticket</Table.Th>
                            <Table.Th>Status</Table.Th>
                            <Table.Th>Resolution</Table.Th>
                            <Table.Th ta="right">Actions</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {(b as Flight).tickets.map((k) => {
                            const last = k.resolutions[k.resolutions.length - 1];
                            return (
                              <Table.Tr key={k.id}>
                                <Table.Td>
                                  {k.first_name} {k.last_name}
                                </Table.Td>
                                <Table.Td>{k.ticket_number ?? '-'}</Table.Td>
                                <Table.Td>
                                  <Badge color={TICKET_COLORS[k.status] ?? 'gray'} variant={k.status === 'open' ? 'filled' : 'light'}>
                                    {labelOf(TICKET_STATUSES, k.status)}
                                  </Badge>
                                </Table.Td>
                                <Table.Td>
                                  {last ? (
                                    <Text size="xs" c="dimmed">
                                      {last.resolution} by {last.resolved_by_name ?? '-'}, {formatTimestamp(last.resolved_at)}
                                      {last.notes ? ` · ${last.notes}` : ''}
                                    </Text>
                                  ) : (
                                    '-'
                                  )}
                                </Table.Td>
                                <Table.Td>
                                  <Group gap={4} justify="flex-end" wrap="nowrap">
                                    {k.status === 'open' && (
                                      <Button size="compact-xs" variant="light" color="orange" leftSection={<IconCheck size={12} />} onClick={() => setResolving(k)}>
                                        Resolve
                                      </Button>
                                    )}
                                    <ActionIcon size="sm" variant="default" aria-label="Edit ticket" onClick={() => setTicketModal({ flightId: b.id, ticket: k })}>
                                      <IconEdit size={14} />
                                    </ActionIcon>
                                    <ActionIcon size="sm" variant="light" color="red" aria-label="Remove ticket" onClick={() => confirmRemove('ticket', `tickets/${k.id}`)}>
                                      <IconTrash size={14} />
                                    </ActionIcon>
                                  </Group>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  )}
                </Card>
              );
            })}
          </Stack>
        )}
      </Card>
    );
  };

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap" align="flex-start">
        <div>
          <Text size="sm" c="dimmed">
            Trip {trip.reference}
            {trip.company_id && (
              <>
                {' · '}
                <Anchor component={Link} to={`/companies/${trip.company_id}`} size="sm">
                  {trip.company_name}
                </Anchor>
              </>
            )}
          </Text>
          <Group gap="sm">
            <Title order={2}>{trip.name}</Title>
            <TripStatusBadge phase={trip.phase} status={trip.status} />
            {openTickets > 0 && (
              <Badge color="orange" variant="filled">
                {openTickets} open ticket{openTickets === 1 ? '' : 's'}
              </Badge>
            )}
          </Group>
        </div>
        <Group>
          <Button component={Link} to={`/trips/${trip.id}/agenda`} variant="light" leftSection={<IconFileTypePdf size={16} />}>
            Travel agenda PDF
          </Button>
          <Button component={Link} to={`/trips/${trip.id}/edit`} variant="default" leftSection={<IconEdit size={16} />}>
            Edit
          </Button>
          {me?.role === 'admin' && (
            <Button
              color="red"
              variant="light"
              leftSection={<IconTrash size={16} />}
              loading={trash.isPending}
              onClick={() => confirm(`Move ${trip.reference} to the trash?`) && trash.mutate()}
            >
              Move to trash
            </Button>
          )}
        </Group>
      </Group>

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          {BOOKING_KINDS.map((k) => (
            <Tabs.Tab key={k} value={k}>
              {BOOKING_DEFS[k].plural} ({data[k].length})
            </Tabs.Tab>
          ))}
          <Tabs.Tab value="documents">Documents ({documents.length})</Tabs.Tab>
          <Tabs.Tab value="activity">Activity history</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <Stack>
            <Card withBorder>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="lg">
                <Field label="Origin" value={trip.origin} />
                <Field label="Departure" value={formatDate(trip.departure_date)} />
                <Field label="Return / end" value={formatDate(trip.return_date)} />
                <Field label="Trip type" value={labelOf(TRIP_TYPES, trip.trip_type)} />
                <Field label="Company" value={trip.company_name} />
                <Field label="Created" value={formatTimestamp(trip.created_at)} />
                <Field label="Last updated" value={formatTimestamp(trip.updated_at)} />
              </SimpleGrid>
              {trip.notes && (
                <Stack mt="lg" gap={0}>
                  <Field label="Notes" value={trip.notes} />
                </Stack>
              )}
            </Card>

            <Card withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={4}>Travellers ({travellers.length})</Title>
                <Button size="xs" variant="light" component={Link} to={`/trips/${trip.id}/edit`}>
                  Change travellers
                </Button>
              </Group>
              {travellers.length === 0 ? (
                <Text c="dimmed" size="sm">
                  No travellers on this trip yet.
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={640}>
                  <Table highlightOnHover verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>ID</Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Company</Table.Th>
                        <Table.Th>Nationality</Table.Th>
                        <Table.Th>Phone</Table.Th>
                        <Table.Th>Passport</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {travellers.map((t) => (
                        <Table.Tr key={t.id}>
                          <Table.Td c="dimmed">{travellerCode(t.id)}</Table.Td>
                          <Table.Td>
                            <Anchor component={Link} to={`/travellers/${t.id}`} fw={500}>
                              {t.first_name} {t.last_name}
                            </Anchor>
                          </Table.Td>
                          <Table.Td>{t.company_name ?? '-'}</Table.Td>
                          <Table.Td>{t.nationality ?? '-'}</Table.Td>
                          <Table.Td>{t.phone ?? '-'}</Table.Td>
                          <Table.Td>{t.passport_expiry ? <ExpiryBadge date={t.passport_expiry} /> : <Text size="sm" c="dimmed">None on file</Text>}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Card>

            <Card withBorder>
              <Title order={4} mb="sm">
                Destinations
              </Title>
              {destinations.length === 0 ? (
                <Text c="dimmed" size="sm">
                  No destinations added.
                </Text>
              ) : (
                <Table verticalSpacing="xs">
                  <Table.Tbody>
                    {destinations.map((d, i) => (
                      <Table.Tr key={d.id}>
                        <Table.Td w={30} fw={600}>
                          {i + 1}.
                        </Table.Td>
                        <Table.Td fw={500}>{[d.city, d.country].filter(Boolean).join(', ')}</Table.Td>
                        <Table.Td c="dimmed">
                          {d.arrival_date || d.departure_date ? `${formatDate(d.arrival_date)} → ${formatDate(d.departure_date)}` : ''}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Card>
          </Stack>
        </Tabs.Panel>

        {BOOKING_KINDS.map((k) => (
          <Tabs.Panel key={k} value={k} pt="md">
            {bookingRows(k)}
          </Tabs.Panel>
        ))}

        <Tabs.Panel value="documents" pt="md">
          <Card withBorder>
            <Group justify="space-between" mb="sm">
              <Title order={4}>Trip documents</Title>
              <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setUploadOpen(true)}>
                Upload document
              </Button>
            </Group>
            {documents.length === 0 ? (
              <Text c="dimmed" size="sm">
                No documents yet. Upload e-tickets, vouchers, itineraries or visa letters.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={560}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Title</Table.Th>
                      <Table.Th>File</Table.Th>
                      <Table.Th>Uploaded</Table.Th>
                      <Table.Th ta="right">Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {documents.map((d) => (
                      <Table.Tr key={d.id}>
                        <Table.Td fw={500}>{d.title}</Table.Td>
                        <Table.Td c="dimmed">
                          {d.original_name} {d.size ? `(${formatSize(d.size)})` : ''}
                        </Table.Td>
                        <Table.Td>
                          {formatTimestamp(d.created_at)}
                          {d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <ActionIcon variant="light" aria-label="View document" onClick={() => setViewing(d)}>
                              <IconEye size={16} />
                            </ActionIcon>
                            <ActionIcon variant="light" color="red" aria-label="Remove document" onClick={() => confirmRemove('document', `documents/${d.id}`)}>
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="activity" pt="md">
          <ActivityHistory entity="trip" id={trip.id} />
        </Tabs.Panel>
      </Tabs>

      {bookingModal && (
        <BookingModal
          tripId={trip.id}
          kind={bookingModal.kind}
          booking={bookingModal.booking}
          travellers={travellers}
          opened
          onClose={() => setBookingModal(null)}
          onSaved={refresh}
        />
      )}
      <TicketModal
        tripId={trip.id}
        flightId={ticketModal?.flightId ?? null}
        ticket={ticketModal?.ticket ?? null}
        travellers={travellers}
        opened={Boolean(ticketModal)}
        onClose={() => setTicketModal(null)}
        onSaved={refresh}
      />
      <ResolveTicketModal tripId={trip.id} ticket={resolving} onClose={() => setResolving(null)} onSaved={refresh} />
      <DocumentUploadModal url={`/trips/${trip.id}/documents`} opened={uploadOpen} onClose={() => setUploadOpen(false)} onSaved={refresh} />
      <FileViewer
        document={viewing}
        src={viewing ? `/api/trips/${trip.id}/documents/${viewing.id}/file` : ''}
        onClose={() => setViewing(null)}
      />
    </Stack>
  );
}
