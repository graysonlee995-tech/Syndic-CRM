import { ActionIcon, Autocomplete, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { Contacts } from '../types';
import { CountrySelect } from './CountrySelect';

/** Extra phone numbers and addresses, as edited in the company and traveller forms. */
export interface ContactsValue {
  phones: { key: number; label: string; number: string }[];
  addresses: { key: number; label: string; address_line: string; state: string; city: string; country: string }[];
}

let nextKey = 1;

export const emptyContacts = (): ContactsValue => ({ phones: [], addresses: [] });

export const contactsToForm = (c: Contacts | undefined): ContactsValue => ({
  phones: (c?.phones ?? []).map((p) => ({ key: nextKey++, label: p.label ?? '', number: p.number })),
  addresses: (c?.addresses ?? []).map((a) => ({
    key: nextKey++,
    label: a.label ?? '',
    address_line: a.address_line ?? '',
    state: a.state ?? '',
    city: a.city ?? '',
    country: a.country ?? '',
  })),
});

/** What the server expects; empty rows are dropped. */
export const contactsToBody = (v: ContactsValue) => ({
  phones: v.phones.filter((p) => p.number.trim()).map(({ key: _k, ...p }) => p),
  addresses: v.addresses.filter((a) => a.address_line.trim() || a.state.trim() || a.city.trim() || a.country.trim()).map(({ key: _k, ...a }) => a),
});

const PHONE_LABELS = ['Mobile', 'WhatsApp', 'Office', 'Home', 'Fax', 'Other'];
const ADDRESS_LABELS = ['Office', 'Home', 'Billing', 'Branch', 'Other'];

type PhoneRow = ContactsValue['phones'][number];
type AddressRow = ContactsValue['addresses'][number];

export function ExtraPhones({ value, onChange }: { value: ContactsValue; onChange: (v: ContactsValue) => void }) {
  const set = (key: number, patch: Partial<PhoneRow>) =>
    onChange({ ...value, phones: value.phones.map((p) => (p.key === key ? { ...p, ...patch } : p)) });
  return (
    <Stack gap="xs">
      {value.phones.map((p) => (
        <Group key={p.key} gap="xs" align="flex-end" wrap="nowrap">
          <Autocomplete
            label="Label"
            placeholder="Mobile"
            data={PHONE_LABELS}
            value={p.label}
            onChange={(label) => set(p.key, { label })}
            w={140}
          />
          <TextInput
            label="Extra phone"
            type="tel"
            value={p.number}
            onChange={(e) => {
              const { value: number } = e.currentTarget;
              set(p.key, { number });
            }}
            style={{ flex: 1 }}
          />
          <Tooltip label="Remove phone">
            <ActionIcon
              variant="subtle"
              color="red"
              size="lg"
              aria-label="Remove phone"
              onClick={() => onChange({ ...value, phones: value.phones.filter((x) => x.key !== p.key) })}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ))}
      <Group>
        <Button
          variant="light"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => onChange({ ...value, phones: [...value.phones, { key: nextKey++, label: '', number: '' }] })}
        >
          Add phone
        </Button>
      </Group>
    </Stack>
  );
}

export function ExtraAddresses({ value, onChange }: { value: ContactsValue; onChange: (v: ContactsValue) => void }) {
  const set = (key: number, patch: Partial<AddressRow>) =>
    onChange({ ...value, addresses: value.addresses.map((a) => (a.key === key ? { ...a, ...patch } : a)) });
  const text = (a: AddressRow, name: 'address_line' | 'state' | 'city') => ({
    value: a[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const { value: v } = e.currentTarget;
      set(a.key, { [name]: v });
    },
  });
  return (
    <Stack gap="xs">
      {value.addresses.map((a, i) => (
        <Stack key={a.key} gap={6} p="xs" style={{ border: '1px dashed var(--mantine-color-default-border)', borderRadius: 8 }}>
          <Group justify="space-between">
            <Text size="xs" fw={600} c="dimmed">
              Extra address {i + 1}
            </Text>
            <Tooltip label="Remove address">
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Remove address"
                onClick={() => onChange({ ...value, addresses: value.addresses.filter((x) => x.key !== a.key) })}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Group gap="xs" align="flex-end" wrap="wrap">
            <Autocomplete
              label="Label"
              placeholder="Office"
              data={ADDRESS_LABELS}
              value={a.label}
              onChange={(label) => set(a.key, { label })}
              w={140}
            />
            <TextInput label="Address" {...text(a, 'address_line')} style={{ flex: '1 1 260px' }} />
          </Group>
          <Group gap="xs" grow align="flex-start">
            <TextInput label="State / province" {...text(a, 'state')} />
            <TextInput label="City" {...text(a, 'city')} />
            <CountrySelect value={a.country} onChange={(country) => set(a.key, { country })} />
          </Group>
        </Stack>
      ))}
      <Group>
        <Button
          variant="light"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            onChange({ ...value, addresses: [...value.addresses, { key: nextKey++, label: '', address_line: '', state: '', city: '', country: '' }] })
          }
        >
          Add address
        </Button>
      </Group>
    </Stack>
  );
}

/** Shows extra phones and addresses on a profile. */
export function ContactsList({ contacts }: { contacts: Contacts | undefined }) {
  if (!contacts || (!contacts.phones.length && !contacts.addresses.length)) return null;
  return (
    <Stack gap={4} mt="md">
      {contacts.phones.map((p) => (
        <Text key={`p${p.id}`} size="sm">
          <Text span size="xs" c="dimmed" tt="uppercase" fw={600}>
            {p.label || 'Phone'}:
          </Text>{' '}
          {p.number}
        </Text>
      ))}
      {contacts.addresses.map((a) => (
        <Text key={`a${a.id}`} size="sm">
          <Text span size="xs" c="dimmed" tt="uppercase" fw={600}>
            {a.label || 'Address'}:
          </Text>{' '}
          {[a.address_line, a.state, a.city, a.country].filter(Boolean).join(', ')}
        </Text>
      ))}
    </Stack>
  );
}
