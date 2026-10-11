import { useEffect, useState } from 'react';
import { Alert, Button, Card, Code, Group, Loader, NumberInput, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconAlertCircle, IconMail, IconPlayerPlay } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient, useAppConfig } from '../api';
import type { Settings } from '../types';

export function SettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: Settings; mailConfigured: boolean; timezone: string }>('/admin/settings'),
  });
  const { scheduledAlerts } = useAppConfig();
  const [thresholds, setThresholds] = useState('');
  const [time, setTime] = useState('08:00');
  const [birthdayReminders, setBirthdayReminders] = useState(true);
  const [birthdayDaysAhead, setBirthdayDaysAhead] = useState<number | string>(7);

  useEffect(() => {
    if (data) {
      setThresholds(data.settings.alertThresholds.join(', '));
      setTime(data.settings.alertTime);
      setBirthdayReminders(data.settings.birthdayReminders);
      setBirthdayDaysAhead(data.settings.birthdayDaysAhead);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const values = thresholds
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
      if (values.some((v) => !Number.isInteger(v) || v < 0)) {
        throw new Error('Alert days must be whole numbers, e.g. 90, 30, 7, 0');
      }
      return api('/admin/settings', {
        method: 'PUT',
        body: {
          alertThresholds: values,
          alertTime: time,
          birthdayReminders,
          birthdayDaysAhead: Number(birthdayDaysAhead) || 0,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      notifySuccess('Settings saved');
    },
    onError: notifyError,
  });

  const testEmail = useMutation({
    mutationFn: () => api<{ message: string }>('/admin/settings/test-email', { method: 'POST' }),
    onSuccess: (r) => notifySuccess(r.message),
    onError: notifyError,
  });

  const runNow = useMutation({
    mutationFn: () => api<{ message: string }>('/admin/settings/run-alerts', { method: 'POST' }),
    onSuccess: (r) => notifySuccess(r.message),
    onError: notifyError,
  });

  if (isLoading || !data) return <Loader />;

  return (
    <Stack maw={720}>
      <Title order={2}>Alert settings</Title>
      {!data.mailConfigured && (
        <Alert color="orange" icon={<IconAlertCircle size={18} />} title="Email is not set up">
          SMTP settings are missing on the server, so alert emails are not being sent. Add the SMTP_* values to the
          server's .env file and restart it.
        </Alert>
      )}
      <Card withBorder>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Stack>
            <TextInput
              label="Send alerts this many days before expiry"
              description="Comma-separated. 0 means on the expiry day, or as soon as an expired document is found. Each document gets one email per step."
              value={thresholds}
              onChange={(e) => setThresholds(e.currentTarget.value)}
            />
            {scheduledAlerts ? (
              <TextInput
                label="Daily check time"
                description={`Time zone: ${data.timezone}`}
                type="time"
                value={time}
                onChange={(e) => setTime(e.currentTarget.value)}
                maw={200}
              />
            ) : (
              <Text size="sm" c="dimmed">
                The daily check runs once a day at the time set in <Code>vercel.json</Code> (08:00 Pakistan time by default).
              </Text>
            )}
            <Switch
              label="Email birthday reminders"
              description="A separate email listing clients whose birthday is coming up, once per client per year."
              checked={birthdayReminders}
              onChange={(e) => setBirthdayReminders(e.currentTarget.checked)}
            />
            <NumberInput
              label="Remind this many days before a birthday"
              description="0 = on the day only"
              min={0}
              max={60}
              maw={200}
              disabled={!birthdayReminders}
              value={birthdayDaysAhead}
              onChange={setBirthdayDaysAhead}
            />
            <Text size="sm" c="dimmed">
              Choose who receives these emails on the Employees page (the "Receives alerts" switch).
            </Text>
            <Group>
              <Button type="submit" loading={save.isPending}>
                Save settings
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>
      <Card withBorder>
        <Stack>
          <Title order={5}>Tools</Title>
          <Group>
            <Button variant="light" leftSection={<IconMail size={16} />} loading={testEmail.isPending} onClick={() => testEmail.mutate()}>
              Send me a test email
            </Button>
            <Button variant="light" leftSection={<IconPlayerPlay size={16} />} loading={runNow.isPending} onClick={() => runNow.mutate()}>
              Run daily checks now
            </Button>
          </Group>
          <Text size="sm" c="dimmed">
            Runs the expiry and birthday checks. It sends only reminders that haven't been sent yet, so it never emails
            the same thing twice.
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}
