import { Stack, Title } from '@mantine/core';
import { useNavigate, useParams } from 'react-router-dom';
import { CompanyForm } from '../components/CompanyForm';

export function CompanyFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <Stack maw={900}>
      <Title order={2}>{id ? 'Edit company' : 'New company'}</Title>
      <CompanyForm
        companyId={id}
        onSaved={(company) => navigate(`/companies/${company.id}`, { replace: true })}
        onCancel={() => navigate(-1)}
      />
    </Stack>
  );
}
