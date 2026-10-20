import { useEffect, useState } from 'react';
import { Button, Card, Group, Loader, Select, SimpleGrid, Stack, TextInput, Textarea, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import type { Client, ClientInput, Contacts } from '../types';
import { contactsToBody, contactsToForm, emptyContacts, ExtraAddresses, ExtraPhones, type ContactsValue } from '../components/ExtraContacts';
import { CountrySelect } from '../components/CountrySelect';
import { CompanyPicker } from '../components/CompanyPicker';

type FormValues = Record<Exclude<keyof ClientInput, 'company_id'>, string> & { company_id: string };

const EMPTY: FormValues = {
  first_name: '',
  last_name: '',
  company_id: '',
  date_of_birth: '',
  gender: '',
  nationality: '',
  phone: '',
  email: '',
  address_line: '',
  state: '',
  city: '',
  country: '',
  seat_preference: '',
  meal_preference: '',
  cabin_preference: '',
  special_requirements: '',
  notes: '',
};

/** Add or edit a traveller. Travellers are stored as clients on the server. */
export function ClientFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormValues>(() => ({ ...EMPTY, company_id: params.get('companyId') ?? '' }));
  const [contacts, setContacts] = useState<ContactsValue>(emptyContacts);

  const existing = useQuery({
    queryKey: ['client', id],
    queryFn: () => api<{ client: Client; contacts: Contacts }>(`/travellers/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    const c = existing.data?.client;
    if (c) {
      setForm(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, String(c[k as keyof ClientInput] ?? '')])) as FormValues);
      setContacts(contactsToForm(existing.data?.contacts));
    }
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, company_id: form.company_id ? Number(form.company_id) : null, ...contactsToBody(contacts) };
      return id
        ? api<{ client: Client }>(`/travellers/${id}`, { method: 'PUT', body })
        : api<{ client: Client }>('/travellers', { body });
    },
    onSuccess: ({ client }) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['client', String(client.id)] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      notifySuccess(id ? 'Traveller updated' : 'Traveller created');
      navigate(`/travellers/${client.id}`, { replace: true });
    },
    onError: notifyError,
  });

  if (id && existing.isLoading) return <Loader />;

  const field = (key: keyof FormValues) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = e.currentTarget;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });
  const select = (key: keyof FormValues) => ({
    value: form[key] || null,
    onChange: (v: string | null) => setForm((f) => ({ ...f, [key]: v ?? '' })),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Stack maw={900}>
        <Title order={2}>{id ? 'Edit traveller' : 'New traveller'}</Title>
        <Card withBorder>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="First name" required {...field('first_name')} autoFocus />
              <TextInput label="Last name" required {...field('last_name')} />
              <CompanyPicker
                value={form.company_id}
                onChange={(company_id) => setForm((f) => ({ ...f, company_id }))}
                placeholder="No company (individual)"
              />
              <TextInput label="Date of birth" type="date" {...field('date_of_birth')} />
              <Select label="Gender" clearable data={['Male', 'Female', 'Other']} {...select('gender')} />
              <TextInput label="Nationality" {...field('nationality')} />
            </SimpleGrid>
          </Stack>
        </Card>

        <Card withBorder>
          <Title order={5} mb="sm">
            Contact details
          </Title>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Phone" type="tel" {...field('phone')} />
              <TextInput label="Email" type="email" {...field('email')} />
            </SimpleGrid>
            <ExtraPhones value={contacts} onChange={setContacts} />
            <TextInput label="Address" {...field('address_line')} />
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput label="State / province" {...field('state')} />
              <TextInput label="City" {...field('city')} />
              <CountrySelect value={form.country} onChange={(country) => setForm((f) => ({ ...f, country }))} />
            </SimpleGrid>
            <ExtraAddresses value={contacts} onChange={setContacts} />
          </Stack>
        </Card>

        <Card withBorder>
          <Title order={5} mb="sm">
            Travel preferences
          </Title>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Select label="Seat" clearable data={['Window', 'Aisle', 'Middle', 'No preference']} {...select('seat_preference')} />
              <Select
                label="Cabin"
                clearable
                data={['Economy', 'Premium economy', 'Business', 'First']}
                {...select('cabin_preference')}
              />
              <TextInput label="Meal" placeholder="e.g. Halal, vegetarian" {...field('meal_preference')} />
            </SimpleGrid>
            <Textarea label="Special requirements" autosize minRows={2} {...field('special_requirements')} />
          </Stack>
        </Card>

        <Card withBorder>
          <Textarea label="Notes" autosize minRows={3} {...field('notes')} />
        </Card>

        <Group>
          <Button type="submit" loading={save.isPending}>
            {id ? 'Save changes' : 'Create traveller'}
          </Button>
          <Button variant="default" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
