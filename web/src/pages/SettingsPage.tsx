import { useEffect, useState } from 'react';
import { Alert, Button, Card, Code, Group, Loader, NumberInput, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconAlertCircle, IconClock, IconMail, IconPlayerPlay } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient, useAppConfig } from '../api';
import type { Settings } from '../types';
import { AssistantKeyCard } from '../components/AssistantKeyCard';
import { EmailSettingsCard } from '../components/EmailSettingsCard';
import { BackupCard } from '../components/BackupCard';
import { QcItemsCard } from '../components/QcItemsCard';
import { LogoCard } from '../components/LogoCard';
import { AppearanceCard } from '../components/ThemeSwitch';

export function SettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: Settings; mailConfigured: boolean }>('/admin/settings'),
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
      if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 30)) {
        throw new Error('Alert days must be whole numbers from 0 to 30, e.g. 30, 7, 0');
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
      <Title order={2}>Settings</Title>
      <AppearanceCard />
      <LogoCard />
      <TimezoneCard current={data.settings.timezone} />
      <QcItemsCard />
      <AssistantKeyCard />
      <EmailSettingsCard />
      <BackupCard />
      <Title order={4} mt="sm">
        Expiry and birthday alerts
      </Title>
      {!data.mailConfigured && (
        <Alert color="orange" icon={<IconAlertCircle size={18} />} title="Email is not set up">
          Alert emails are not being sent yet. Fill in the Email section above and click Check and save.
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
              description="Comma-separated, at most 30 days. 0 means on the expiry day, or as soon as an expired document is found. Each document gets one email per step."
              value={thresholds}
              onChange={(e) => setThresholds(e.currentTarget.value)}
            />
            {scheduledAlerts ? (
              <TextInput
                label="Daily check time"
                description={`CRM time zone: ${data.settings.timezone}`}
                type="time"
                value={time}
                onChange={(e) => setTime(e.currentTarget.value)}
                maw={200}
              />
            ) : (
              <Text size="sm" c="dimmed">
                The daily check runs once a day at the time set in <Code>vercel.json</Code> (13:00 UTC by default: 08:00 New York
                time in winter, 09:00 in summer).
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

/** Every time zone the browser knows, with common US and other zones a staff member is likely to look for. */
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Asia/Dubai', 'Asia/Karachi', 'UTC'];
  }
})();

const nowIn = (timeZone: string) => {
  try {
    return new Date().toLocaleString(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' });
  } catch {
    return '';
  }
};

/** The CRM's time zone: "today" for alerts and trip status, the daily check time and how times are shown. */
function TimezoneCard({ current }: { current: string }) {
  const [zone, setZone] = useState(current);
  useEffect(() => setZone(current), [current]);
  const save = useMutation({
    mutationFn: () => api('/admin/timezone', { method: 'PUT', body: { timezone: zone } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      notifySuccess(`Time zone set to ${zone}`);
    },
    onError: notifyError,
  });
  const data = ZONES.includes(current) ? ZONES : [current, ...ZONES];
  return (
    <Card withBorder>
      <Stack>
        <Group gap="xs">
          <IconClock size={18} />
          <Title order={5}>Time zone</Title>
        </Group>
        <Text size="sm" c="dimmed">
          Decides what "today" is (alerts, upcoming and past trips), when the daily check runs and how times are shown in the
          CRM. The default is US Eastern time (America/New_York, EST/EDT).
        </Text>
        <Group align="flex-end">
          <Select
            label="CRM time zone"
            searchable
            allowDeselect={false}
            data={data}
            value={zone}
            onChange={(v) => setZone(v ?? current)}
            description={nowIn(zone) ? `Now: ${nowIn(zone)}` : undefined}
            maxDropdownHeight={300}
            w={320}
          />
          <Button variant="light" onClick={() => setZone('America/New_York')} disabled={zone === 'America/New_York'}>
            Use US Eastern
          </Button>
          <Button loading={save.isPending} disabled={zone === current} onClick={() => save.mutate()}>
            Save time zone
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
