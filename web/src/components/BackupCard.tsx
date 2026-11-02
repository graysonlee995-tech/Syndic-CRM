import { useState } from 'react';
import { Alert, Button, Card, FileInput, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle, IconDatabase, IconDownload, IconUpload } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { api, notifyError, queryClient } from '../api';

/** Download a backup of all records, or replace everything with one (admins only). */
export function BackupCard() {
  const [file, setFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const restore = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('confirm', confirmText);
      if (file) form.append('file', file);
      return api<{ counts: Record<string, number> }>('/admin/restore', { form });
    },
    onSuccess: () => {
      alert('The backup was imported. Everyone has been signed out; sign in with an account from the backup.');
      queryClient.clear();
      queryClient.setQueryData(['me'], null);
    },
    onError: notifyError,
  });

  return (
    <Card withBorder>
      <Group gap="xs" mb="xs">
        <IconDatabase size={20} />
        <Title order={4}>Backup</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        A backup file holds every record: trips, companies, travellers, documents' details, settings and employee logins (passwords
        stay hashed). Keep it somewhere safe. Uploaded scans are stored separately, encrypted, and are not inside the file.
      </Text>
      <Group mb="lg">
        <Button component="a" href="/api/admin/backup" leftSection={<IconDownload size={16} />}>
          Download backup
        </Button>
      </Group>

      <Stack gap="xs" p="sm" style={{ border: '1px solid var(--mantine-color-red-6)', borderRadius: 8 }}>
        <Group gap="xs">
          <IconAlertTriangle size={18} color="var(--mantine-color-red-6)" />
          <Text fw={600} c="red">
            Import a backup
          </Text>
        </Group>
        <Text size="sm">
          This <b>replaces all current data</b> with the backup's contents. Anything added since that backup is lost, and everyone is
          signed out. Download a backup of the current data first.
        </Text>
        <FileInput
          label="Backup file"
          placeholder="syndic-crm-backup-….json.gz"
          accept=".gz,.json,application/gzip,application/json"
          leftSection={<IconUpload size={16} />}
          value={file}
          onChange={setFile}
          clearable
        />
        <TextInput
          label="Type RESTORE to confirm"
          value={confirmText}
          onChange={(e) => {
            const { value } = e.currentTarget;
            setConfirmText(value);
          }}
          maw={260}
        />
        {restore.isPending && (
          <Alert color="yellow" p="xs">
            Importing… do not close this page.
          </Alert>
        )}
        <Group>
          <Button color="red" disabled={!file || confirmText !== 'RESTORE'} loading={restore.isPending} onClick={() => restore.mutate()}>
            Replace all data with this backup
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
