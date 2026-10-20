import { useState } from 'react';
import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title, Group } from '@mantine/core';
import { IconLock, IconPlane } from '@tabler/icons-react';
import { api, queryClient } from '../api';
import type { User } from '../types';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user?: User; needTotp?: boolean }>('/auth/login', {
        body: { email, password, totp: needTotp ? totp : undefined },
      });
      if (res.needTotp) setNeedTotp(true);
      else if (res.user) queryClient.setQueryData(['me'], res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" p="md" bg="var(--mantine-color-body)">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={400}>
        <form onSubmit={submit}>
          <Stack>
            <Group gap="xs">
              <IconPlane size={28} color="var(--mantine-primary-color-filled)" />
              <Title order={2}>Syndic CRM</Title>
            </Group>
            <Text c="dimmed" size="sm">
              Employees only. Sign in with the login you were given by your administrator.
            </Text>
            {error && (
              <Alert color="red" icon={<IconLock size={16} />}>
                {error}
              </Alert>
            )}
            <TextInput
              label="Email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              disabled={needTotp}
              autoFocus
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              disabled={needTotp}
            />
            {needTotp && (
              <TextInput
                label="Authentication code"
                description="Enter the 6-digit code from your authenticator app"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                autoFocus
                value={totp}
                onChange={(e) => setTotp(e.currentTarget.value)}
              />
            )}
            <Button type="submit" loading={busy} fullWidth>
              Sign in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
