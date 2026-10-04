import { useState } from 'react';
import { ActionIcon, Button, Card, Group, Loader, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconEdit, IconEye, IconPlus, IconTrash, IconPaperclip } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient, useMe } from '../api';
import { DocumentFormModal } from '../components/DocumentFormModal';
import { DocumentViewer } from '../components/DocumentViewer';
import { ExpiryBadge, formatDate, formatTimestamp } from '../format';
import { documentLabel, type Client, type ClientDocument } from '../types';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value || '-'}</Text>
    </div>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const [editing, setEditing] = useState<ClientDocument | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [viewing, setViewing] = useState<ClientDocument | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['client', id],
    queryFn: () => api<{ client: Client; documents: ClientDocument[] }>(`/clients/${id}`),
  });

  const deleteClient = useMutation({
    mutationFn: () => api(`/clients/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      notifySuccess('Client deleted');
      navigate('/clients', { replace: true });
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

  if (isLoading) return <Loader />;
  if (error || !data) return <Text c="red">{(error as Error)?.message ?? 'Client not found'}</Text>;
  const { client, documents } = data;

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <Title order={2}>
          {client.first_name} {client.last_name}
        </Title>
        <Group>
          <Button component={Link} to={`/clients/${client.id}/edit`} variant="default" leftSection={<IconEdit size={16} />}>
            Edit
          </Button>
          {isAdmin && (
            <Button
              color="red"
              variant="light"
              leftSection={<IconTrash size={16} />}
              loading={deleteClient.isPending}
              onClick={() => {
                if (confirm(`Permanently delete ${client.first_name} ${client.last_name} and all their documents?`)) {
                  deleteClient.mutate();
                }
              }}
            >
              Delete
            </Button>
          )}
        </Group>
      </Group>

      <Card withBorder>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="lg">
          <Field label="Date of birth" value={formatDate(client.date_of_birth)} />
          <Field label="Gender" value={client.gender} />
          <Field label="Nationality" value={client.nationality} />
          <Field label="Phone" value={client.phone} />
          <Field label="Email" value={client.email} />
          <Field label="Address" value={[client.address_line, client.city, client.country].filter(Boolean).join(', ')} />
          <Field label="Last updated" value={formatTimestamp(client.updated_at)} />
        </SimpleGrid>
        {client.notes && (
          <Stack mt="lg" gap={0}>
            <Field label="Notes" value={client.notes} />
          </Stack>
        )}
      </Card>

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
            No documents yet. Add the client's passport, ID card or licence with its expiry date.
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

      <DocumentFormModal clientId={client.id} document={editing} opened={formOpen} onClose={() => setFormOpen(false)} />
      <DocumentViewer document={viewing} onClose={() => setViewing(null)} />
    </Stack>
  );
}
