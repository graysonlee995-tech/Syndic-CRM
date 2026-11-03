import { useEffect, useState } from 'react';
import { Button, Card, Group, Loader, Select, SimpleGrid, Stack, TextInput, Textarea, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import type { Client, ClientInput, Contacts } from '../types';
import {
  contactsToBody,
  contactsToForm,
  emptyContacts,
  ExtraAddresses,
  ExtraEmails,
  ExtraPhones,
  PLACEHOLDERS,
  type ContactsValue,
} from './ExtraContacts';
import { CountrySelect } from './CountrySelect';
import { CompanyMultiPicker } from './CompanyMultiPicker';
import { SabreEntriesInput } from './SabreEntries';

type FormValues = Record<Exclude<keyof ClientInput, 'company_ids'>, string> & { company_ids: string[] };

const EMPTY: FormValues = {
  first_name: '',
  last_name: '',
  company_ids: [],
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
  sabre_entry: '',
};

interface Props {
  /** Edit this traveller; omit to create one. */
  clientId?: string;
  /** A company a new traveller starts in ('' for none). */
  initialCompanyId?: string;
  /** Pre-fills a new traveller's name (e.g. what was typed in a traveller search). */
  initialName?: string;
  onSaved: (client: Client) => void;
  onCancel: () => void;
  /** Inside a pop-up: no card frames, buttons on the right. */
  inModal?: boolean;
}

/** Splits "John Smith" into first and last name. */
const splitName = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return { first_name: words.slice(0, Math.max(1, words.length - 1)).join(' '), last_name: words.length > 1 ? words.at(-1)! : '' };
};

/** Traveller add/edit form, used on the Travellers pages and in the "Add traveller" pop-up. Travellers are stored as clients. */
export function ClientForm({ clientId, initialCompanyId = '', initialName = '', onSaved, onCancel, inModal = false }: Props) {
  const [form, setForm] = useState<FormValues>(() => ({
    ...EMPTY,
    ...splitName(initialName.toUpperCase()),
    company_ids: initialCompanyId ? [initialCompanyId] : [],
  }));
  const [contacts, setContacts] = useState<ContactsValue>(emptyContacts);

  const existing = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => api<{ client: Client; contacts: Contacts }>(`/travellers/${clientId}`),
    enabled: Boolean(clientId),
  });

  useEffect(() => {
    const c = existing.data?.client;
    if (c) {
      setForm({
        ...(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, String(c[k as keyof ClientInput] ?? '')])) as unknown as FormValues),
        company_ids: c.company_ids.map(String),
      });
      setContacts(contactsToForm(existing.data?.contacts));
    }
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, company_ids: form.company_ids.map(Number), ...contactsToBody(contacts) };
      return clientId
        ? api<{ client: Client }>(`/travellers/${clientId}`, { method: 'PUT', body })
        : api<{ client: Client }>('/travellers', { body });
    },
    onSuccess: ({ client }) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] }); // includes the traveller pickers
      queryClient.invalidateQueries({ queryKey: ['client', String(client.id)] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      notifySuccess(clientId ? 'Traveller updated' : `Traveller ${client.first_name} ${client.last_name} created`);
      onSaved(client);
    },
    onError: notifyError,
  });

  if (clientId && existing.isLoading) return <Loader />;

  const field = (key: Exclude<keyof FormValues, 'company_ids'>) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = e.currentTarget;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });
  const upper = (key: 'first_name' | 'last_name') => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.currentTarget.value.toUpperCase();
      setForm((f) => ({ ...f, [key]: value }));
    },
  });
  const select = (key: Exclude<keyof FormValues, 'company_ids'>) => ({
    value: form[key] || null,
    onChange: (v: string | null) => setForm((f) => ({ ...f, [key]: v ?? '' })),
  });
  const section = (title: string, body: React.ReactNode) =>
    inModal ? (
      <Stack gap="xs">
        <Title order={6}>{title}</Title>
        {body}
      </Stack>
    ) : (
      <Card withBorder>
        <Title order={5} mb="sm">
          {title}
        </Title>
        {body}
      </Card>
    );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // In the pop-up this form sits inside the trip form; don't submit that one too.
        e.stopPropagation();
        save.mutate();
      }}
    >
      <Stack>
        {section(
          'Traveller',
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {/* Names are kept in capitals (the server converts them too). */}
            <TextInput label="Given name" required placeholder="e.g. JOHN" {...upper('first_name')} data-autofocus autoFocus={!inModal} />
            <TextInput label="Last name" required placeholder="e.g. SMITH" {...upper('last_name')} />
            <CompanyMultiPicker value={form.company_ids} onChange={(company_ids) => setForm((f) => ({ ...f, company_ids }))} />
            <TextInput label="Date of birth" type="date" {...field('date_of_birth')} />
            <Select label="Gender" clearable placeholder="Select" data={['Male', 'Female', 'Other']} {...select('gender')} />
            <CountrySelect label="Nationality" value={form.nationality} onChange={(nationality) => setForm((f) => ({ ...f, nationality }))} />
          </SimpleGrid>,
        )}

        {section(
          'Contact details',
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Phone" type="tel" placeholder={PLACEHOLDERS.phone} {...field('phone')} />
              <TextInput label="Email" type="email" placeholder={PLACEHOLDERS.email} {...field('email')} />
            </SimpleGrid>
            <ExtraEmails value={contacts} onChange={setContacts} />
            <ExtraPhones value={contacts} onChange={setContacts} />
            <TextInput label="Address" placeholder={PLACEHOLDERS.address} {...field('address_line')} />
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput label="State/Province" placeholder={PLACEHOLDERS.state} {...field('state')} />
              <TextInput label="City" placeholder={PLACEHOLDERS.city} {...field('city')} />
              <CountrySelect value={form.country} onChange={(country) => setForm((f) => ({ ...f, country }))} />
            </SimpleGrid>
            <ExtraAddresses value={contacts} onChange={setContacts} />
          </Stack>,
        )}

        {section(
          'Travel preferences',
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Select label="Seat" clearable placeholder="Select" data={['Window', 'Aisle', 'Middle', 'No preference']} {...select('seat_preference')} />
              <Select
                label="Cabin"
                clearable
                placeholder="Select"
                data={['Economy', 'Premium economy', 'Business', 'First']}
                {...select('cabin_preference')}
              />
              <TextInput label="Meal" placeholder="e.g. Halal, vegetarian" {...field('meal_preference')} />
            </SimpleGrid>
            <Textarea label="Special requirements" placeholder="e.g. Wheelchair assistance" autosize minRows={2} {...field('special_requirements')} />
          </Stack>,
        )}

        {(() => {
          const boxes = (
            <Stack>
              <Textarea label="Notes" autosize minRows={inModal ? 2 : 3} {...field('notes')} />
              <SabreEntriesInput value={form.sabre_entry} onChange={(sabre_entry) => setForm((f) => ({ ...f, sabre_entry }))} />
            </Stack>
          );
          return inModal ? boxes : <Card withBorder>{boxes}</Card>;
        })()}

        <Group justify={inModal ? 'flex-end' : 'flex-start'}>
          {inModal && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={save.isPending}>
            {clientId ? 'Save changes' : 'Create traveller'}
          </Button>
          {!inModal && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Group>
      </Stack>
    </form>
  );
}
