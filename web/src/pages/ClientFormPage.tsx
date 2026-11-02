import { Stack, Title } from '@mantine/core';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ClientForm } from '../components/ClientForm';

/** Add or edit a traveller. Travellers are stored as clients on the server. */
export function ClientFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <Stack maw={900}>
      <Title order={2}>{id ? 'Edit traveller' : 'New traveller'}</Title>
      <ClientForm
        clientId={id}
        initialCompanyId={params.get('companyId') ?? ''}
        onSaved={(client) => navigate(`/travellers/${client.id}`, { replace: true })}
        onCancel={() => navigate(-1)}
      />
    </Stack>
  );
}
