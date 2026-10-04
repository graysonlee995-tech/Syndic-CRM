import { useState } from 'react';
import { Badge, Button, Card, Code, Group, Image, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient, useMe } from '../api';
import type { User } from '../types';

function ChangePassword() {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirmPassword, setConfirm] = useState('');
  const change = useMutation({
    mutationFn: () => {
      if (newPassword !== confirmPassword) throw new Error('The new passwords do not match');
      return api('/auth/password', { body: { currentPassword, newPassword } });
    },
    onSuccess: () => {
      setCurrent('');
      setNew('');
      setConfirm('');
      notifySuccess('Password changed. Other devices have been signed out.');
    },
    onError: notifyError,
  });

  return (
    <Card withBorder>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <Stack>
          <Title order={4}>Change password</Title>
          <PasswordInput label="Current password" required autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.currentTarget.value)} />
          <PasswordInput label="New password" description="At least 10 characters" required minLength={10} autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.currentTarget.value)} />
          <PasswordInput label="Repeat new password" required autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirm(e.currentTarget.value)} />
          <Group>
            <Button type="submit" loading={change.isPending}>
              Change password
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function TwoFactor({ user }: { user: User }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const updated = ({ user }: { user: User }) => {
    queryClient.setQueryData(['me'], user);
    setSetup(null);
    setCode('');
    setPassword('');
  };

  const start = useMutation({
    mutationFn: () => api<{ secret: string; qr: string }>('/auth/2fa/setup', { method: 'POST' }),
    onSuccess: setSetup,
    onError: notifyError,
  });
  const enable = useMutation({
    mutationFn: () => api<{ user: User }>('/auth/2fa/enable', { body: { code } }),
    onSuccess: (r) => {
      updated(r);
      notifySuccess('Two-factor authentication is on');
    },
    onError: notifyError,
  });
  const disable = useMutation({
    mutationFn: () => api<{ user: User }>('/auth/2fa/disable', { body: { password } }),
    onSuccess: (r) => {
      updated(r);
      notifySuccess('Two-factor authentication is off');
    },
    onError: notifyError,
  });

  return (
    <Card withBorder>
      <Stack>
        <Group>
          <Title order={4}>Two-factor authentication</Title>
          <Badge color={user.totp_enabled ? 'teal' : 'gray'}>{user.totp_enabled ? 'On' : 'Off'}</Badge>
        </Group>
        <Text size="sm" c="dimmed">
          Asks for a code from an authenticator app (Google Authenticator, Microsoft Authenticator) when you sign in.
          Strongly recommended because this system holds passport and ID copies.
        </Text>
        {user.totp_enabled ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            <Group align="flex-end">
              <PasswordInput label="Password to turn it off" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
              <Button type="submit" color="red" variant="light" loading={disable.isPending}>
                Turn off
              </Button>
            </Group>
          </form>
        ) : setup ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              enable.mutate();
            }}
          >
            <Stack>
              <Text size="sm">1. Scan this QR code with your authenticator app:</Text>
              <Image src={setup.qr} w={200} h={200} alt="Authenticator QR code" />
              <Text size="xs" c="dimmed">
                Or enter this key manually: <Code>{setup.secret}</Code>
              </Text>
              <Group align="flex-end">
                <TextInput label="2. Enter the 6-digit code it shows" inputMode="numeric" required value={code} onChange={(e) => setCode(e.currentTarget.value)} />
                <Button type="submit" loading={enable.isPending}>
                  Turn on
                </Button>
              </Group>
            </Stack>
          </form>
        ) : (
          <Group>
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              Set up two-factor authentication
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

export function AccountPage() {
  const { data: user } = useMe();
  if (!user) return null;
  return (
    <Stack maw={640}>
      <Title order={2}>My account</Title>
      <Text>
        {user.name} · {user.email} · <Badge variant="light">{user.role}</Badge>
      </Text>
      <ChangePassword />
      <TwoFactor user={user} />
    </Stack>
  );
}
