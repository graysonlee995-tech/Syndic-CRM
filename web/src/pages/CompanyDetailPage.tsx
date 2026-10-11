import { useState } from 'react';
import { ActionIcon, Button, Card, Group, Loader, SimpleGrid, Stack, Table, Tabs, Text, Title } from '@mantine/core';
import { IconEdit, IconEye, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient, useMe } from '../api';
import { ActivityHistory } from '../components/ActivityHistory';
import { Field } from '../components/Field';
import { TravellersTable } from '../components/TravellersTable';
import { DocumentUploadModal, FileViewer } from '../components/TripModals';
import { TripsTable } from '../components/TripsTable';
import { companyCode, formatSize, formatTimestamp } from '../format';
import type { Company, CompanyDocument } from '../types';

export function CompanyDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewing, setViewing] = useState<CompanyDocument | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['company', id],
    queryFn: () => api<{ company: Company; documents: CompanyDocument[] }>(`/companies/${id}`),
  });

  const trash = useMutation({
    mutationFn: () => api(`/companies/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      notifySuccess('Company moved to the trash');
      navigate('/companies', { replace: true });
    },
    onError: notifyError,
  });

  const removeDocument = useMutation({
    mutationFn: (docId: number) => api(`/companies/${id}/documents/${docId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company', id] });
      notifySuccess('Document removed');
    },
    onError: notifyError,
  });

  if (isLoading) return <Loader />;
  if (error || !data) return <Text c="red">{(error as Error)?.message ?? 'Company not found'}</Text>;
  const { company, documents } = data;
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['company', id] });
    queryClient.invalidateQueries({ queryKey: ['activity', 'company', company.id] });
  };

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <div>
          <Text size="sm" c="dimmed">
            Company {companyCode(company.id)}
          </Text>
          <Title order={2}>{company.name}</Title>
        </div>
        <Group>
          <Button component={Link} to={`/companies/${company.id}/edit`} variant="default" leftSection={<IconEdit size={16} />}>
            Edit
          </Button>
          {me?.role === 'admin' && (
            <Button
              color="red"
              variant="light"
              leftSection={<IconTrash size={16} />}
              loading={trash.isPending}
              onClick={() => {
                if (confirm(`Move ${company.name} to the trash? Its travellers and trips are kept.`)) trash.mutate();
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
          <Tabs.Tab value="travellers">Travellers</Tabs.Tab>
          <Tabs.Tab value="trips">Trips</Tabs.Tab>
          <Tabs.Tab value="documents">Documents ({documents.length})</Tabs.Tab>
          <Tabs.Tab value="activity">Activity history</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <Stack>
            <Card withBorder>
              <Title order={4} mb="sm">
                Contact information
              </Title>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="lg">
                <Field label="Primary contact" value={company.primary_contact} />
                <Field label="Phone" value={company.phone} />
                <Field label="Email" value={company.email} />
                <Field label="Address" value={[company.address_line, company.city, company.country].filter(Boolean).join(', ')} />
                <Field label="Created" value={formatTimestamp(company.created_at)} />
                <Field label="Last updated" value={formatTimestamp(company.updated_at)} />
              </SimpleGrid>
              {company.notes && (
                <Stack mt="lg" gap={0}>
                  <Field label="Notes" value={company.notes} />
                </Stack>
              )}
            </Card>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="travellers" pt="md">
          <Stack>
            <Group justify="flex-end">
              <Button component={Link} to={`/travellers/new?companyId=${company.id}`} leftSection={<IconPlus size={16} />}>
                Add traveller
              </Button>
            </Group>
            <TravellersTable companyId={company.id} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="trips" pt="md">
          <Stack>
            <Group justify="flex-end">
              <Button component={Link} to={`/trips/new?companyId=${company.id}`} leftSection={<IconPlus size={16} />}>
                Add trip
              </Button>
            </Group>
            <TripsTable companyId={company.id} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="documents" pt="md">
          <Card withBorder>
            <Group justify="space-between" mb="sm">
              <div>
                <Title order={4}>Company documents</Title>
                <Text size="sm" c="dimmed">
                  Optional: contracts, travel policies, invoices or other files for this company.
                </Text>
              </div>
              <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setUploadOpen(true)}>
                Upload document
              </Button>
            </Group>
            {documents.length === 0 ? (
              <Text c="dimmed" size="sm">
                No documents uploaded.
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
                            <ActionIcon
                              variant="light"
                              color="red"
                              aria-label="Remove document"
                              onClick={() => confirm(`Remove ${d.title}?`) && removeDocument.mutate(d.id)}
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

        <Tabs.Panel value="activity" pt="md">
          <ActivityHistory entity="company" id={company.id} />
        </Tabs.Panel>
      </Tabs>

      <DocumentUploadModal url={`/companies/${company.id}/documents`} opened={uploadOpen} onClose={() => setUploadOpen(false)} onSaved={refresh} />
      <FileViewer
        document={viewing}
        src={viewing ? `/api/companies/${company.id}/documents/${viewing.id}/file` : ''}
        onClose={() => setViewing(null)}
      />
    </Stack>
  );
}
