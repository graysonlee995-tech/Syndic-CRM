import { useEffect, useState } from 'react';
import { Button, Group, Modal, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconFileUpload, IconX } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient, useAppConfig } from '../api';
import { formatSize } from '../format';
import { DOCUMENT_TYPES, type ClientDocument } from '../types';

const ACCEPT = { 'application/pdf': ['.pdf'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'] };

const blank = {
  type: 'passport',
  document_number: '',
  issuing_country: '',
  issue_date: '',
  expiry_date: '',
  notes: '',
};

interface Props {
  clientId: number;
  document: ClientDocument | null;
  opened: boolean;
  onClose: () => void;
}

export function DocumentFormModal({ clientId, document, opened, onClose }: Props) {
  const [form, setForm] = useState(blank);
  const [file, setFile] = useState<File | null>(null);
  const { maxUploadMb } = useAppConfig();

  useEffect(() => {
    if (!opened) return;
    setFile(null);
    setForm(
      document
        ? {
            type: document.type,
            document_number: document.document_number ?? '',
            issuing_country: document.issuing_country ?? '',
            issue_date: document.issue_date ?? '',
            expiry_date: document.expiry_date ?? '',
            notes: document.notes ?? '',
          }
        : blank,
    );
  }, [opened, document]);

  const save = useMutation({
    mutationFn: () => {
      const data = new FormData();
      Object.entries(form).forEach(([k, v]) => data.append(k, v));
      if (file) data.append('file', file);
      return document
        ? api(`/documents/${document.id}`, { method: 'PUT', form: data })
        : api(`/travellers/${clientId}/documents`, { form: data });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client', String(clientId)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      notifySuccess(document ? 'Document updated' : 'Document added');
      onClose();
    },
    onError: notifyError,
  });

  const field = (key: keyof typeof blank) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = e.currentTarget;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={document ? 'Edit document' : 'Add document'} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label="Document type"
              required
              allowDeselect={false}
              data={DOCUMENT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              value={form.type}
              onChange={(v) => setForm((f) => ({ ...f, type: v ?? 'passport' }))}
            />
            <TextInput label="Document number" {...field('document_number')} />
            <TextInput label="Issuing country" {...field('issuing_country')} />
            <TextInput label="Issue date" type="date" {...field('issue_date')} />
            <TextInput
              label="Expiry date"
              type="date"
              description="Used for expiry alerts"
              {...field('expiry_date')}
            />
          </SimpleGrid>
          <Textarea label="Notes" autosize minRows={2} {...field('notes')} />

          <Dropzone
            onDrop={(files) => setFile(files[0] ?? null)}
            onReject={() => notifyError(new Error(`Only PDF, JPG, PNG or WEBP files up to ${maxUploadMb} MB`))}
            maxSize={maxUploadMb * 1024 * 1024}
            maxFiles={1}
            multiple={false}
            accept={ACCEPT}
          >
            <Group justify="center" gap="md" mih={90} style={{ pointerEvents: 'none' }}>
              <Dropzone.Accept>
                <IconFileUpload size={36} color="var(--mantine-color-teal-6)" />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX size={36} color="var(--mantine-color-red-6)" />
              </Dropzone.Reject>
              <Dropzone.Idle>
                <IconFileUpload size={36} color="var(--mantine-color-dimmed)" />
              </Dropzone.Idle>
              <div>
                <Text size="sm" fw={500}>
                  {file
                    ? `${file.name} (${formatSize(file.size)})`
                    : document?.original_name
                      ? 'Drop a new scan here to replace the current file'
                      : 'Drop a scan here or click to choose a file'}
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
            <Button type="submit" loading={save.isPending}>
              {document ? 'Save' : 'Add document'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
