import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconEdit, IconEye, IconPlus, IconTrash, IconPaperclip } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient, useMe } from '../api';
import { ActivityHistory } from '../components/ActivityHistory';
import { DocumentFormModal } from '../components/DocumentFormModal';
import { DocumentViewer } from '../components/DocumentViewer';
import { Field } from '../components/Field';
import { ContactsList } from '../components/ExtraContacts';
import { TripsTable } from '../components/TripsTable';
import { ExpiryBadge, formatDate, formatTimestamp, travellerCode } from '../format';
import { documentLabel, type Client, type ClientDocument, type LoyaltyMembership, type Contacts } from '../types';

const BLANK_LOYALTY = { airline: '', programme: '', member_number: '', tier: '' };

function LoyaltyModal({
  clientId,
  membership,
  opened,
  onClose,
}: {
  clientId: number;
  membership: LoyaltyMembership | null;
  opened: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState(BLANK_LOYALTY);
  useEffect(() => {
    if (!opened) return;
    setForm(
      membership
        ? {
            airline: membership.airline,
            programme: membership.programme ?? '',
            member_number: membership.member_number,
            tier: membership.tier ?? '',
          }
        : BLANK_LOYALTY,
    );
  }, [opened, membership]);

  const save = useMutation({
    mutationFn: () =>
      membership
        ? api(`/travellers/${clientId}/loyalty/${membership.id}`, { method: 'PUT', body: form })
        : api(`/travellers/${clientId}/loyalty`, { body: form }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client', String(clientId)] });
      queryClient.invalidateQueries({ queryKey: ['activity', 'client', clientId] });
      notifySuccess(membership ? 'Membership updated' : 'Membership added');
      onClose();
    },
    onError: notifyError,
  });

  const field = (key: keyof typeof BLANK_LOYALTY) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = e.currentTarget;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={membership ? 'Edit membership' : 'Add frequent flyer membership'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          <TextInput label="Airline" required placeholder="e.g. Emirates" {...field('airline')} autoFocus />
          <TextInput label="Programme" placeholder="e.g. Skywards" {...field('programme')} />
          <TextInput label="Membership number" required {...field('member_number')} />
          <TextInput label="Tier" placeholder="e.g. Gold" {...field('tier')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The traveller profile. Travellers are stored as clients on the server. */
export function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const [editing, setEditing] = useState<ClientDocument | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [viewing, setViewing] = useState<ClientDocument | null>(null);
  const [loyalty, setLoyalty] = useState<{ open: boolean; membership: LoyaltyMembership | null }>({ open: false, membership: null });

  const { data, isLoading, error } = useQuery({
    queryKey: ['client', id],
    queryFn: () => api<{ client: Client; contacts: Contacts; documents: ClientDocument[]; loyalty: LoyaltyMembership[] }>(`/travellers/${id}`),
  });

  const trashClient = useMutation({
    mutationFn: () => api(`/travellers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      notifySuccess('Traveller moved to the trash');
      navigate('/travellers', { replace: true });
    },
    onError: notifyError,
  });

  const deleteDocument = useMutation({
    mutationFn: (docId: number) => api(`/documents/${docId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client', id] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      notifySuccess('Document deleted');
    },
    onError: notifyError,
  });

  const deleteLoyalty = useMutation({
    mutationFn: (loyaltyId: number) => api(`/travellers/${id}/loyalty/${loyaltyId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client', id] });
      notifySuccess('Membership removed');
    },
    onError: notifyError,
  });

  if (isLoading) return <Loader />;
  if (error || !data) return <Text c="red">{(error as Error)?.message ?? 'Traveller not found'}</Text>;
  const { client, documents, loyalty: memberships } = data;

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <div>
          <Text size="sm" c="dimmed">
            Traveller {travellerCode(client.id)}
            {client.company_id && (
              <>
                {' · '}
                <Anchor component={Link} to={`/companies/${client.company_id}`} size="sm">
                  {client.company_name}
                </Anchor>
              </>
            )}
          </Text>
          <Title order={2}>
            {client.first_name} {client.last_name}
          </Title>
        </div>
        <Group>
          <Button component={Link} to={`/trips/new?travellerId=${client.id}${client.company_id ? `&companyId=${client.company_id}` : ''}`} variant="light" leftSection={<IconPlus size={16} />}>
            Add trip
          </Button>
          <Button component={Link} to={`/travellers/${client.id}/edit`} variant="default" leftSection={<IconEdit size={16} />}>
            Edit
          </Button>
          {isAdmin && (
            <Button
              color="red"
              variant="light"
              leftSection={<IconTrash size={16} />}
              loading={trashClient.isPending}
              onClick={() => {
                if (confirm(`Move ${client.first_name} ${client.last_name} to the trash? An administrator can restore them from Trash.`)) {
                  trashClient.mutate();
                }
              }}
            >
              Move to trash
            </Button>
          )}
        </Group>
      </Group>

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="documents">Documents ({documents.length})</Tabs.Tab>
          <Tabs.Tab value="loyalty">Frequent flyer ({memberships.length})</Tabs.Tab>
          <Tabs.Tab value="trips">Trips</Tabs.Tab>
          <Tabs.Tab value="activity">Activity history</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <Stack>
            <Card withBorder>
              <Title order={4} mb="sm">
                Overview
              </Title>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="lg">
                <Field label="Date of birth" value={formatDate(client.date_of_birth)} />
                <Field label="Gender" value={client.gender} />
                <Field label="Nationality" value={client.nationality} />
                <Field label="Company" value={client.company_name} />
                <Field label="Last updated" value={formatTimestamp(client.updated_at)} />
              </SimpleGrid>
              {client.notes && (
                <Stack mt="lg" gap={0}>
                  <Field label="Notes" value={client.notes} />
                </Stack>
              )}
            </Card>
            <Card withBorder>
              <Title order={4} mb="sm">
                Contact details
              </Title>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="lg">
                <Field label="Phone" value={client.phone} />
                <Field label="Email" value={client.email} />
                <Field label="Address" value={[client.address_line, client.state, client.city, client.country].filter(Boolean).join(', ')} />
              </SimpleGrid>
              <ContactsList contacts={data.contacts} />
            </Card>
            <Card withBorder>
              <Title order={4} mb="sm">
                Travel preferences
              </Title>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="lg">
                <Field label="Seat" value={client.seat_preference} />
                <Field label="Cabin" value={client.cabin_preference} />
                <Field label="Meal" value={client.meal_preference} />
                <Field label="Special requirements" value={client.special_requirements} />
              </SimpleGrid>
            </Card>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="documents" pt="md">
          <Card withBorder>
            <Group justify="space-between" mb="sm">
              <Title order={4}>Documents</Title>
              <Button
                size="sm"
                leftSection={<IconPlus size={16} />}
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                Add document
              </Button>
            </Group>
            {documents.length === 0 ? (
              <Text c="dimmed" size="sm">
                No documents yet. Add the traveller's passport, ID card or licence with its expiry date.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={720}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Number</Table.Th>
                      <Table.Th>Issuing country</Table.Th>
                      <Table.Th>Issued</Table.Th>
                      <Table.Th>Expires</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th ta="right">Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {documents.map((d) => (
                      <Table.Tr key={d.id}>
                        <Table.Td fw={500}>{documentLabel(d.type)}</Table.Td>
                        <Table.Td>{d.document_number ?? '-'}</Table.Td>
                        <Table.Td>{d.issuing_country ?? '-'}</Table.Td>
                        <Table.Td>{formatDate(d.issue_date)}</Table.Td>
                        <Table.Td>{formatDate(d.expiry_date)}</Table.Td>
                        <Table.Td>
                          <ExpiryBadge date={d.expiry_date} />
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            {d.file_name ? (
                              <Tooltip label="View scan">
                                <ActionIcon variant="light" onClick={() => setViewing(d)} aria-label="View scan">
                                  <IconEye size={16} />
                                </ActionIcon>
                              </Tooltip>
                            ) : (
                              <Tooltip label="No scan uploaded">
                                <ActionIcon variant="subtle" color="gray" disabled aria-label="No scan uploaded">
                                  <IconPaperclip size={16} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                            <Tooltip label="Edit or replace scan">
                              <ActionIcon
                                variant="default"
                                aria-label="Edit document"
                                onClick={() => {
                                  setEditing(d);
                                  setFormOpen(true);
                                }}
                              >
                                <IconEdit size={16} />
                              </ActionIcon>
                            </Tooltip>
                            {isAdmin && (
                              <Tooltip label="Delete">
                                <ActionIcon
                                  variant="light"
                                  color="red"
                                  aria-label="Delete document"
                                  onClick={() => {
                                    if (confirm(`Delete this ${documentLabel(d.type).toLowerCase()} and its scan?`)) {
                                      deleteDocument.mutate(d.id);
                                    }
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
            )}
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="loyalty" pt="md">
          <Card withBorder>
            <Group justify="space-between" mb="sm">
              <Title order={4}>Frequent flyer memberships</Title>
              <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setLoyalty({ open: true, membership: null })}>
                Add membership
              </Button>
            </Group>
            {memberships.length === 0 ? (
              <Text c="dimmed" size="sm">
                No memberships yet.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={520}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Airline</Table.Th>
                      <Table.Th>Programme</Table.Th>
                      <Table.Th>Number</Table.Th>
                      <Table.Th>Tier</Table.Th>
                      <Table.Th ta="right">Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {memberships.map((m) => (
                      <Table.Tr key={m.id}>
                        <Table.Td fw={500}>{m.airline}</Table.Td>
                        <Table.Td>{m.programme ?? '-'}</Table.Td>
                        <Table.Td>{m.member_number}</Table.Td>
                        <Table.Td>{m.tier ?? '-'}</Table.Td>
                        <Table.Td>
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <ActionIcon variant="default" aria-label="Edit membership" onClick={() => setLoyalty({ open: true, membership: m })}>
                              <IconEdit size={16} />
                            </ActionIcon>
                            <ActionIcon
                              variant="light"
                              color="red"
                              aria-label="Remove membership"
                              onClick={() => confirm(`Remove the ${m.airline} membership?`) && deleteLoyalty.mutate(m.id)}
                            >
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

        <Tabs.Panel value="trips" pt="md">
          <TripsTable travellerId={client.id} />
        </Tabs.Panel>

        <Tabs.Panel value="activity" pt="md">
          <ActivityHistory entity="client" id={client.id} />
        </Tabs.Panel>
      </Tabs>

      <DocumentFormModal clientId={client.id} document={editing} opened={formOpen} onClose={() => setFormOpen(false)} />
      <DocumentViewer document={viewing} onClose={() => setViewing(null)} />
      <LoyaltyModal
        clientId={client.id}
        membership={loyalty.membership}
        opened={loyalty.open}
        onClose={() => setLoyalty((l) => ({ ...l, open: false }))}
      />
    </Stack>
  );
}
