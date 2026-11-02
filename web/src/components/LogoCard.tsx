import { Button, Card, FileButton, Group, Stack, Text, Title } from '@mantine/core';
import { IconPhoto, IconTrash, IconUpload } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { api, logoUrl, notifyError, notifySuccess, queryClient, useAppConfig } from '../api';

const MAX_BYTES = 512 * 1024;

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });

/** The agency logo: shown in the CRM header, on the sign-in page and at the top right of travel agenda PDFs. */
export function LogoCard() {
  const logo = logoUrl(useAppConfig().logoVersion);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) throw new Error('The logo must be 512 KB or smaller.');
      return api('/admin/logo', { method: 'PUT', body: { dataUrl: await readAsDataUrl(file) } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      notifySuccess('Logo saved');
    },
    onError: notifyError,
  });

  const remove = useMutation({
    mutationFn: () => api('/admin/logo', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      notifySuccess('Logo removed');
    },
    onError: notifyError,
  });

  return (
    <Card withBorder>
      <Stack>
        <Group gap="xs">
          <IconPhoto size={18} />
          <Title order={5}>Logo</Title>
        </Group>
        <Text size="sm" c="dimmed">
          Shown in the CRM header, on the sign-in page and at the top right of every travel agenda PDF. PNG, JPEG or WebP, up to
          512 KB. A wide logo on a transparent or white background prints best.
        </Text>
        {logo && (
          <div style={{ background: '#fff', border: '1px solid var(--mantine-color-default-border)', borderRadius: 8, padding: 12, alignSelf: 'flex-start' }}>
            <img src={logo} alt="Current logo" style={{ maxHeight: 80, maxWidth: 280, objectFit: 'contain', display: 'block' }} />
          </div>
        )}
        <Group>
          <FileButton onChange={(f) => f && upload.mutate(f)} accept="image/png,image/jpeg,image/webp">
            {(props) => (
              <Button {...props} leftSection={<IconUpload size={16} />} loading={upload.isPending}>
                {logo ? 'Replace logo' : 'Upload logo'}
              </Button>
            )}
          </FileButton>
          {logo && (
            <Button variant="default" color="red" leftSection={<IconTrash size={16} />} loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
