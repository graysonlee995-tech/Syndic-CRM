import { useEffect, useState } from 'react';
import { Badge, Button, Card, Group, Loader, NumberInput, PasswordInput, SegmentedControl, SimpleGrid, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconMail, IconSend, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';

interface MailStatus {
  configured: boolean;
  source: 'settings' | 'environment' | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  passwordSet: boolean;
}

const PRESETS: Record<string, { host: string; port: number; secure: boolean; hint: string }> = {
  office365: {
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    hint: 'Use the mailbox email and password. SMTP sign-in (SMTP AUTH) must be enabled for the mailbox in Microsoft 365 admin.',
  },
  gmail: {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    hint: 'Use the Gmail address and an App Password (Google Account > Security > 2-Step Verification > App passwords), not the normal password.',
  },
  custom: { host: '', port: 587, secure: false, hint: 'Ask your email provider for the SMTP server, port and security type.' },
};

const presetFor = (host: string | null) =>
  host === PRESETS.office365.host ? 'office365' : host === PRESETS.gmail.host ? 'gmail' : host ? 'custom' : 'office365';

/** Admins set up the mailbox that sends expiry alerts and birthday reminders. */
export function EmailSettingsCard() {
  const status = useQuery({ queryKey: ['email-settings'], queryFn: () => api<MailStatus>('/admin/email') });
  const [preset, setPreset] = useState('office365');
  const [form, setForm] = useState({ host: PRESETS.office365.host, port: 587, secure: false, user: '', password: '', fromName: 'Syndic CRM', fromEmail: '' });

  // Start from what is saved; the password is never sent to the browser.
  useEffect(() => {
    const s = status.data;
    if (!s?.configured) return;
    const match = s.from?.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
    setPreset(presetFor(s.host));
    setForm({
      host: s.host ?? '',
      port: s.port ?? 587,
      secure: s.secure,
      user: s.user ?? '',
      password: '',
      fromName: match ? match[1].trim() : '',
      fromEmail: match ? match[2].trim() : (s.from ?? ''),
    });
  }, [status.data]);

  const choose = (p: string) => {
    setPreset(p);
    const { host, port, secure } = PRESETS[p];
    setForm((f) => ({ ...f, host: p === 'custom' ? f.host : host, port, secure }));
  };

  const refresh = (s: MailStatus) => {
    queryClient.setQueryData(['email-settings'], s);
    queryClient.invalidateQueries({ queryKey: ['settings'] }); // the "email is not set up" notice
  };

  const save = useMutation({
    mutationFn: () => {
      const fromEmail = form.fromEmail.trim() || form.user.trim();
      return api<MailStatus>('/admin/email', {
        method: 'PUT',
        body: {
          host: form.host,
          port: form.port,
          secure: form.secure,
          user: form.user,
          password: form.password,
          from: form.fromName.trim() ? `${form.fromName.trim()} <${fromEmail}>` : fromEmail,
        },
      });
    },
    onSuccess: (s) => {
      refresh(s);
      setForm((f) => ({ ...f, password: '' }));
      notifySuccess('Signed in to the mail server and saved. Send a test email to be sure.');
    },
    onError: notifyError,
  });

  const test = useMutation({
    mutationFn: () => api<{ message: string }>('/admin/settings/test-email', { method: 'POST' }),
    onSuccess: (r) => notifySuccess(r.message),
    onError: notifyError,
  });

  const remove = useMutation({
    mutationFn: () => api<MailStatus>('/admin/email', { method: 'DELETE' }),
    onSuccess: (s) => {
      refresh(s);
      notifySuccess('Email settings removed');
    },
    onError: notifyError,
  });

  const s = status.data;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const text = (key: 'host' | 'user' | 'password' | 'fromName' | 'fromEmail') => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = e.currentTarget;
      set(key, value);
    },
  });

  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconMail size={20} />
          <Title order={4}>Email</Title>
        </Group>
        {status.isLoading ? (
          <Loader size="xs" />
        ) : s?.configured ? (
          <Badge variant="light">{s.source === 'environment' ? 'Set up on the server' : 'Set up'}</Badge>
        ) : (
          <Badge color="gray" variant="light">
            Not set up
          </Badge>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        The mailbox that sends document expiry alerts and birthday reminders.
        {s?.source === 'environment' && ' It is currently set in the server settings; saving here replaces that.'}
      </Text>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack gap="sm">
          <SegmentedControl
            value={preset}
            onChange={choose}
            data={[
              { value: 'office365', label: 'Office 365 / Outlook' },
              { value: 'gmail', label: 'Gmail / Google Workspace' },
              { value: 'custom', label: 'Other' },
            ]}
          />
          <Text size="xs" c="dimmed">
            {PRESETS[preset].hint}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <TextInput label="SMTP server" required {...text('host')} />
            <NumberInput label="Port" required min={1} max={65535} value={form.port} onChange={(v) => set('port', Number(v) || 587)} />
            <Switch
              label="SSL (port 465)"
              description="Off for 587 (STARTTLS)"
              checked={form.secure}
              onChange={(e) => {
                const { checked } = e.currentTarget;
                set('secure', checked);
              }}
              mt="lg"
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Mailbox (username)" placeholder="crm@your-agency.com" {...text('user')} />
            <PasswordInput
              label="Password"
              placeholder={s?.passwordSet ? 'Saved (leave empty to keep it)' : ''}
              autoComplete="new-password"
              {...text('password')}
            />
            <TextInput label="Sender name" placeholder="Syndic CRM" {...text('fromName')} />
            <TextInput label="Sender email" placeholder="Same as the mailbox" {...text('fromEmail')} />
          </SimpleGrid>
          <Group>
            <Button type="submit" loading={save.isPending} disabled={!form.host.trim()}>
              Check and save
            </Button>
            <Button variant="default" leftSection={<IconSend size={14} />} loading={test.isPending} disabled={!s?.configured} onClick={() => test.mutate()}>
              Send me a test email
            </Button>
            {s?.source === 'settings' && (
              <Button
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={14} />}
                loading={remove.isPending}
                onClick={() => confirm('Remove the email settings? Alert emails stop until new settings are saved.') && remove.mutate()}
              >
                Remove
              </Button>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            Saving signs in to the mail server first, so mistakes show up straight away. The password is stored encrypted and never shown again.
          </Text>
        </Stack>
      </form>
    </Card>
  );
}
