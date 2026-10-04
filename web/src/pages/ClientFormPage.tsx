import { useEffect, useState } from 'react';
import { Button, Card, Group, Loader, Select, SimpleGrid, Stack, TextInput, Textarea, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import type { Client, ClientInput } from '../types';

const EMPTY: Record<keyof ClientInput, string> = {
  first_name: '',
  last_name: '',
  date_of_birth: '',
  gender: '',
  nationality: '',
  phone: '',
  email: '',
  address_line: '',
  city: '',
  country: '',
  notes: '',
};

export function ClientFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);

  const existing = useQuery({
    queryKey: ['client', id],
    queryFn: () => api<{ client: Client }>(`/clients/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    const c = existing.data?.client;
    if (c) setForm(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, c[k as keyof ClientInput] ?? ''])) as typeof EMPTY);
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () =>
      id
        ? api<{ client: Client }>(`/clients/${id}`, { method: 'PUT', body: form })
        : api<{ client: Client }>('/clients', { body: form }),
    onSuccess: ({ client }) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['client', String(client.id)] });
      notifySuccess(id ? 'Client updated' : 'Client created');
      navigate(`/clients/${client.id}`, { replace: true });
    },
    onError: notifyError,
  });

  if (id && existing.isLoading) return <Loader />;

  const field = (key: keyof ClientInput) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.currentTarget.value })),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Stack maw={900}>
        <Title order={2}>{id ? 'Edit client' : 'New client'}</Title>
        <Card withBorder>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="First name" required {...field('first_name')} autoFocus />
              <TextInput label="Last name" required {...field('last_name')} />
              <TextInput label="Date of birth" type="date" {...field('date_of_birth')} />
              <Select
                label="Gender"
                clearable
                data={['Male', 'Female', 'Other']}
                value={form.gender || null}
                onChange={(v) => setForm((f) => ({ ...f, gender: v ?? '' }))}
              />
              <TextInput label="Nationality" {...field('nationality')} />
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
            {id ? 'Save changes' : 'Create client'}
          </Button>
          <Button variant="default" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
