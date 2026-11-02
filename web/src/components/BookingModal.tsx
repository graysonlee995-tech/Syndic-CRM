import { useEffect, useState } from 'react';
import { Button, Group, Modal, MultiSelect, Select, SimpleGrid, Stack, TextInput, Textarea } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { api, notifyError, notifySuccess } from '../api';
import type { Booking, TripTraveller } from '../types';
import { BOOKING_DEFS, type BookingKind } from './bookings';

interface Props {
  tripId: number;
  kind: BookingKind;
  booking: Booking | null;
  travellers: TripTraveller[];
  opened: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/** Add or edit a flight, hotel, car or cruise on a trip. */
export function BookingModal({ tripId, kind, booking, travellers, opened, onClose, onSaved }: Props) {
  const def = BOOKING_DEFS[kind];
  const [values, setValues] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<string[]>([]);

  useEffect(() => {
    if (!opened) return;
    setValues(
      Object.fromEntries(
        def.fields.map((f) => {
          const v = booking?.[f.key];
          return [f.key, typeof v === 'string' ? v : ''];
        }),
      ),
    );
    // New hotel and car bookings default to everyone on the trip.
    setPeople(booking ? (booking.traveller_ids ?? []).map(String) : travellers.map((t) => String(t.id)));
  }, [opened, booking, def, travellers]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...values, traveller_ids: def.people ? people.map(Number) : [] };
      return booking
        ? api(`/trips/${tripId}/${kind}/${booking.id}`, { method: 'PUT', body })
        : api(`/trips/${tripId}/${kind}`, { body });
    },
    onSuccess: () => {
      notifySuccess(`${def.singular} ${booking ? 'updated' : 'added'}`);
      onSaved();
      onClose();
    },
    onError: notifyError,
  });

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <Modal opened={opened} onClose={onClose} title={`${booking ? 'Edit' : 'Add'} ${def.singular.toLowerCase()}`} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {def.fields
              .filter((f) => f.type !== 'textarea')
              .map((f) =>
                f.type === 'select' ? (
                  <Select
                    key={f.key}
                    label={f.label}
                    clearable
                    data={f.options ?? []}
                    value={values[f.key] || null}
                    onChange={(v) => set(f.key, v ?? '')}
                  />
                ) : (
                  <TextInput
                    key={f.key}
                    label={f.label}
                    required={f.required}
                    placeholder={f.placeholder}
                    type={f.type === 'datetime' ? 'datetime-local' : f.type === 'date' ? 'date' : 'text'}
                    value={values[f.key] ?? ''}
                    onChange={(e) => set(f.key, e.currentTarget.value)}
                  />
                ),
              )}
          </SimpleGrid>
          {def.people && (
            <MultiSelect
              label={def.people}
              description="Optional. Leave empty if not known yet."
              placeholder={people.length ? undefined : 'No one assigned'}
              data={travellers.map((t) => ({ value: String(t.id), label: `${t.first_name} ${t.last_name}` }))}
              value={people}
              onChange={setPeople}
              clearable
            />
          )}
          {def.fields
            .filter((f) => f.type === 'textarea')
            .map((f) => (
              <Textarea key={f.key} label={f.label} autosize minRows={2} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.currentTarget.value)} />
            ))}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
