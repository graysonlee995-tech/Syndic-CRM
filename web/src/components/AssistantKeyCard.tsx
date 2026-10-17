import { useState } from 'react';
import { Anchor, Badge, Button, Card, Group, Loader, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { IconSparkles, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';

interface KeyStatus {
  configured: boolean;
  source: 'settings' | 'environment' | null;
  last4: string | null;
  model: string;
}

/** Admins add or replace the assistant's Anthropic API key. The key is never shown again after saving. */
export function AssistantKeyCard() {
  const [apiKey, setApiKey] = useState('');
  const status = useQuery({ queryKey: ['assistant-key'], queryFn: () => api<KeyStatus>('/admin/assistant-key') });

  const refresh = (s: KeyStatus) => {
    queryClient.setQueryData(['assistant-key'], s);
    queryClient.invalidateQueries({ queryKey: ['config'] }); // shows or hides the Assistant chat
  };

  const save = useMutation({
    mutationFn: () => api<KeyStatus>('/admin/assistant-key', { method: 'PUT', body: { apiKey } }),
    onSuccess: (s) => {
      refresh(s);
      setApiKey('');
      notifySuccess('Key checked with Anthropic and saved. The assistant is ready.');
    },
    onError: notifyError,
  });

  const remove = useMutation({
    mutationFn: () => api<KeyStatus>('/admin/assistant-key', { method: 'DELETE' }),
    onSuccess: (s) => {
      refresh(s);
      notifySuccess('Key removed');
    },
    onError: notifyError,
  });

  const s = status.data;
  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconSparkles size={20} color="var(--mantine-color-teal-6)" />
          <Title order={4}>AI assistant</Title>
        </Group>
        {status.isLoading ? (
          <Loader size="xs" />
        ) : s?.configured ? (
          <Badge color="teal" variant="light">
            Connected
          </Badge>
        ) : (
          <Badge color="gray" variant="light">
            Not set up
          </Badge>
        )}
      </Group>

      {s?.configured && (
        <Text size="sm" mb="sm">
          Using the key ending in <b>…{s.last4}</b>
          {s.source === 'environment' ? ' from the server settings (ANTHROPIC_API_KEY).' : ', saved here.'} Model: {s.model}.
        </Text>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack gap="xs">
          <PasswordInput
            label={s?.configured ? 'Replace the API key' : 'Anthropic API key'}
            placeholder="sk-ant-api03-…"
            description={
              <>
                Create one at{' '}
                <Anchor href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer" size="xs">
                  platform.claude.com → API keys
                </Anchor>
                . Use the <b>Copy</b> button in the window that shows the full key (it is shown only once). The key is
                checked with Anthropic, stored encrypted and never shown again.
              </>
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.currentTarget.value)}
            autoComplete="off"
          />
          <Group>
            <Button type="submit" loading={save.isPending} disabled={!apiKey.trim()}>
              Check and save
            </Button>
            {s?.source === 'settings' && (
              <Button
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={14} />}
                loading={remove.isPending}
                onClick={() => confirm('Remove the saved API key? The assistant stops working until a new key is added.') && remove.mutate()}
              >
                Remove key
              </Button>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            Usage is billed to your Anthropic account. Assistant questions send the CRM details they need to Anthropic;
            passport and ID numbers are never sent.
          </Text>
        </Stack>
      </form>
    </Card>
  );
}
