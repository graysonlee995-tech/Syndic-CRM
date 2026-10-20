import { useEffect, useState } from 'react';
import { Button, Card, Group, Loader, SimpleGrid, Stack, TextInput, Textarea } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import type { Company, CompanyInput, Contacts } from '../types';
import { contactsToBody, contactsToForm, emptyContacts, ExtraAddresses, ExtraPhones, type ContactsValue } from './ExtraContacts';
import { CountrySelect } from './CountrySelect';

const EMPTY: Record<keyof CompanyInput, string> = {
  name: '',
  primary_contact: '',
  phone: '',
  email: '',
  address_line: '',
  state: '',
  city: '',
  country: '',
  notes: '',
};

interface Props {
  /** Edit this company; omit to create one. */
  companyId?: string;
  /** Pre-fills the name of a new company (e.g. what was typed in a company search). */
  initialName?: string;
  onSaved: (company: Company) => void;
  onCancel: () => void;
  /** Inside a pop-up: no card frame around the fields. */
  inModal?: boolean;
}

/** Company add/edit form, used on the Companies pages and in the "Add company" pop-up. */
export function CompanyForm({ companyId, initialName, onSaved, onCancel, inModal = false }: Props) {
  const [form, setForm] = useState(() => ({ ...EMPTY, name: initialName ?? '' }));
  const [contacts, setContacts] = useState<ContactsValue>(emptyContacts);

  const existing = useQuery({
    queryKey: ['company', companyId],
    queryFn: () => api<{ company: Company; contacts: Contacts }>(`/companies/${companyId}`),
    enabled: Boolean(companyId),
  });

  useEffect(() => {
    const c = existing.data?.company;
    if (c) {
      setForm(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, c[k as keyof CompanyInput] ?? ''])) as typeof EMPTY);
      setContacts(contactsToForm(existing.data?.contacts));
    }
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, ...contactsToBody(contacts) };
      return companyId
        ? api<{ company: Company }>(`/companies/${companyId}`, { method: 'PUT', body })
        : api<{ company: Company }>('/companies', { body });
    },
    onSuccess: ({ company }) => {
      queryClient.invalidateQueries({ queryKey: ['companies'] }); // includes the company pickers
      queryClient.invalidateQueries({ queryKey: ['company', String(company.id)] });
      // Company names appear in trip and traveller lists.
      queryClient.invalidateQueries({ queryKey: ['trips'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      notifySuccess(companyId ? 'Company updated' : `Company "${company.name}" created`);
      onSaved(company);
    },
    onError: notifyError,
  });

  if (companyId && existing.isLoading) return <Loader />;

  const field = (key: keyof CompanyInput) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = e.currentTarget;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  const fields = (
    <Stack>
      <TextInput label="Company name" required {...field('name')} data-autofocus autoFocus={!inModal} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Primary contact" {...field('primary_contact')} />
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
      <Textarea label="Notes" autosize minRows={inModal ? 2 : 3} {...field('notes')} />
    </Stack>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // In the pop-up this form sits inside the traveller form; don't submit that one too.
        e.stopPropagation();
        save.mutate();
      }}
    >
      <Stack>
        {inModal ? fields : <Card withBorder>{fields}</Card>}
        <Group justify={inModal ? 'flex-end' : 'flex-start'}>
          {inModal && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={save.isPending}>
            {companyId ? 'Save changes' : 'Create company'}
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
