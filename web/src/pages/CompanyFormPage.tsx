import { useEffect, useState } from 'react';
import { Button, Card, Group, Loader, SimpleGrid, Stack, TextInput, Textarea, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import type { Company, CompanyInput } from '../types';

const EMPTY: Record<keyof CompanyInput, string> = {
  name: '',
  primary_contact: '',
  phone: '',
  email: '',
  address_line: '',
  city: '',
  country: '',
  notes: '',
};

export function CompanyFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);

  const existing = useQuery({
    queryKey: ['company', id],
    queryFn: () => api<{ company: Company }>(`/companies/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    const c = existing.data?.company;
    if (c) setForm(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, c[k as keyof CompanyInput] ?? ''])) as typeof EMPTY);
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () =>
      id
        ? api<{ company: Company }>(`/companies/${id}`, { method: 'PUT', body: form })
        : api<{ company: Company }>('/companies', { body: form }),
    onSuccess: ({ company }) => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['company', String(company.id)] });
      // Company names appear in trip and traveller lists.
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      notifySuccess(id ? 'Company updated' : 'Company created');
      navigate(`/companies/${company.id}`, { replace: true });
    },
    onError: notifyError,
  });

  if (id && existing.isLoading) return <Loader />;

  const field = (key: keyof CompanyInput) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = e.currentTarget;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Stack maw={900}>
        <Title order={2}>{id ? 'Edit company' : 'New company'}</Title>
        <Card withBorder>
          <Stack>
            <TextInput label="Company name" required {...field('name')} autoFocus />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Primary contact" {...field('primary_contact')} />
              <TextInput label="Phone" type="tel" {...field('phone')} />
              <TextInput label="Email" type="email" {...field('email')} />
            </SimpleGrid>
            <TextInput label="Address" {...field('address_line')} />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="City" {...field('city')} />
              <TextInput label="Country" {...field('country')} />
            </SimpleGrid>
            <Textarea label="Notes" autosize minRows={3} {...field('notes')} />
          </Stack>
        </Card>
        <Group>
          <Button type="submit" loading={save.isPending}>
            {id ? 'Save changes' : 'Create company'}
          </Button>
          <Button variant="default" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
