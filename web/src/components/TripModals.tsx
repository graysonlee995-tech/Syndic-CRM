import { useEffect, useState } from 'react';
import { Button, Group, Image, Modal, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconDownload, IconFileUpload } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, useAppConfig } from '../api';
import { formatSize } from '../format';
import { TICKET_STATUSES, type Ticket, type TripTraveller } from '../types';
import { PdfPages } from './PdfPages';

interface TicketModalProps {
  tripId: number;
  /** Set when adding a ticket to this flight. */
  flightId: number | null;
  ticket: Ticket | null;
  travellers: TripTraveller[];
  opened: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function TicketModal({ tripId, flightId, ticket, travellers, opened, onClose, onSaved }: TicketModalProps) {
  const [form, setForm] = useState({ client_id: '', ticket_number: '', status: 'issued', notes: '' });

  useEffect(() => {
    if (!opened) return;
    setForm(
      ticket
        ? { client_id: String(ticket.client_id), ticket_number: ticket.ticket_number ?? '', status: ticket.status, notes: ticket.notes ?? '' }
        : { client_id: travellers.length === 1 ? String(travellers[0].id) : '', ticket_number: '', status: 'issued', notes: '' },
    );
  }, [opened, ticket, travellers]);

  const save = useMutation({
    mutationFn: () =>
      ticket
        ? api(`/trips/${tripId}/tickets/${ticket.id}`, { method: 'PUT', body: form })
        : api(`/trips/${tripId}/flights/${flightId}/tickets`, { body: form }),
    onSuccess: () => {
      notifySuccess(ticket ? 'Ticket updated' : 'Ticket added');
      onSaved();
      onClose();
    },
    onError: notifyError,
  });

  return (
    <Modal opened={opened} onClose={onClose} title={ticket ? 'Edit ticket' : 'Add ticket'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          <Select
            label="Traveller"
            required
            allowDeselect={false}
            data={travellers.map((t) => ({ value: String(t.id), label: `${t.first_name} ${t.last_name}` }))}
            value={form.client_id || null}
            onChange={(v) => setForm((f) => ({ ...f, client_id: v ?? '' }))}
            nothingFoundMessage="Add travellers to the trip first"
          />
          <TextInput
            label="Ticket number"
            value={form.ticket_number}
            onChange={(e) => {
              const { value } = e.currentTarget;
              setForm((f) => ({ ...f, ticket_number: value }));
            }}
          />
          <Select
            label="Status"
            description="Open = unused ticket that still needs to be used, refunded or exchanged"
            allowDeselect={false}
            data={TICKET_STATUSES.map((s) => ({ value: s.value, label: s.label }))}
            value={form.status}
            onChange={(v) => setForm((f) => ({ ...f, status: v ?? 'issued' }))}
          />
          <Textarea label="Notes" autosize minRows={2} value={form.notes} onChange={(e) => {
              const { value } = e.currentTarget;
              setForm((f) => ({ ...f, notes: value }));
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!form.client_id}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function ResolveTicketModal({
  tripId,
  ticket,
  onClose,
  onSaved,
}: {
  tripId: number;
  ticket: Ticket | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [resolution, setResolution] = useState('used');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    setResolution('used');
    setNotes('');
  }, [ticket]);

  const save = useMutation({
    mutationFn: () => api(`/trips/${tripId}/tickets/${ticket!.id}/resolve`, { body: { resolution, notes } }),
    onSuccess: () => {
      notifySuccess('Ticket resolved');
      onSaved();
      onClose();
    },
    onError: notifyError,
  });

  return (
    <Modal opened={Boolean(ticket)} onClose={onClose} title="Resolve open ticket">
      {ticket && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Stack>
            <Text size="sm">
              {ticket.first_name} {ticket.last_name} · {ticket.ticket_number ?? 'no ticket number'}
            </Text>
            <Select
              label="Resolution"
              allowDeselect={false}
              data={[
                { value: 'used', label: 'Used (flown)' },
                { value: 'refunded', label: 'Refunded' },
                { value: 'exchanged', label: 'Exchanged / reissued' },
                { value: 'void', label: 'Void' },
              ]}
              value={resolution}
              onChange={(v) => setResolution(v ?? 'used')}
            />
            <Textarea label="Notes" placeholder="e.g. refund amount, new ticket number" autosize minRows={2} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                Resolve
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

const ACCEPT = { 'application/pdf': ['.pdf'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'] };

/** Uploads a titled file to a trip or company (url is its documents endpoint). */
export function DocumentUploadModal({ url, opened, onClose, onSaved }: { url: string; opened: boolean; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { maxUploadMb } = useAppConfig();
  useEffect(() => {
    if (opened) {
      setTitle('');
      setFile(null);
    }
  }, [opened]);

  const save = useMutation({
    mutationFn: () => {
      const data = new FormData();
      data.append('title', title);
      if (file) data.append('file', file);
      return api(url, { form: data });
    },
    onSuccess: () => {
      notifySuccess('Document uploaded');
      onSaved();
      onClose();
    },
    onError: notifyError,
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Upload document">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          <TextInput label="Title" placeholder="e.g. E-ticket, hotel voucher, visa letter" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          <Dropzone
            onDrop={(files) => setFile(files[0] ?? null)}
            onReject={() => notifyError(new Error(`Only PDF, JPG, PNG or WEBP files up to ${maxUploadMb} MB`))}
            maxSize={maxUploadMb * 1024 * 1024}
            maxFiles={1}
            multiple={false}
            accept={ACCEPT}
          >
            <Group justify="center" gap="md" mih={90} style={{ pointerEvents: 'none' }}>
              <IconFileUpload size={36} color="var(--mantine-color-dimmed)" />
              <div>
                <Text size="sm" fw={500}>
                  {file ? `${file.name} (${formatSize(file.size)})` : 'Drop a file here or click to choose'}
                </Text>
                <Text size="xs" c="dimmed">
                  PDF, JPG, PNG or WEBP, up to {maxUploadMb} MB
                </Text>
              </div>
            </Group>
          </Dropzone>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!file}>
              Upload
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Shows a trip or company document; src is its file URL. */
export function FileViewer({ document, src, onClose }: { document: { title: string; mime_type: string | null } | null; src: string; onClose: () => void }) {
  return (
    <Modal opened={Boolean(document)} onClose={onClose} size="80rem" title={document?.title}>
      {document && (
        <>
          {document.mime_type === 'application/pdf' ? (
            <PdfPages src={src} />
          ) : (
            <Image src={src} alt={document.title} fit="contain" mah="75vh" />
          )}
          <Group justify="flex-end" mt="sm">
            <Button component="a" href={`${src}?download=1`} variant="light" leftSection={<IconDownload size={16} />}>
              Download
            </Button>
          </Group>
        </>
      )}
    </Modal>
  );
}
