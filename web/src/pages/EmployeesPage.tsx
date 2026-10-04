import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconBell, IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, notifySuccess, queryClient } from '../api';
import { formatTimestamp } from '../format';
import type { Role, User } from '../types';

interface FormState {
  name: string;
  email: string;
  role: Role;
  receives_alerts: boolean;
  is_active: boolean;
  password: string;
  reset_2fa: boolean;
  unlock: boolean;
}

const blank: FormState = {
  name: '',
  email: '',
  role: 'staff',
  receives_alerts: false,
  is_active: true,
  password: '',
  reset_2fa: false,
  unlock: false,
};

function EmployeeModal({ user, opened, onClose }: { user: User | null; opened: boolean; onClose: () => void }) {
  const [form, setForm] = useState(blank);
  useEffect(() => {
    if (opened) setForm(user ? { ...blank, ...user, password: '' } : blank);
  }, [opened, user]);

  const save = useMutation({
    mutationFn: () => {
      if (!user) {
        const { name, email, role, receives_alerts, password } = form;
        return api('/users', { body: { name, email, role, receives_alerts, password } });
      }
      return api(`/users/${user.id}`, {
        method: 'PUT',
        body: {
          name: form.name,
          email: form.email,
          role: form.role,
          receives_alerts: form.receives_alerts,
          is_active: form.is_active,
          password: form.password || undefined,
          reset_2fa: form.reset_2fa || undefined,
          unlock: form.unlock || undefined,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
      notifySuccess(user ? 'Employee updated' : 'Employee created');
      onClose();
    },
    onError: notifyError,
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal opened={opened} onClose={onClose} title={user ? `Edit ${user.name}` : 'New employee'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          <TextInput label="Full name" required value={form.name} onChange={(e) => set('name', e.currentTarget.value)} />
          <TextInput
            label="Email (login ID)"
            type="email"
            required
            value={form.email}
            onChange={(e) => set('email', e.currentTarget.value)}
          />
          <Select
            label="Role"
            allowDeselect={false}
            data={[
              { value: 'staff', label: 'Staff: manage clients and documents' },
              { value: 'admin', label: 'Admin: also employees, settings, deletions and audit log' },
            ]}
            value={form.role}
            onChange={(v) => set('role', (v ?? 'staff') as Role)}
          />
          <PasswordInput
            label={user ? 'New password' : 'Password'}
            description={user ? 'Leave empty to keep the current password' : 'At least 10 characters. Share it privately.'}
            required={!user}
            minLength={10}
            value={form.password}
            onChange={(e) => set('password', e.currentTarget.value)}
            autoComplete="new-password"
          />
          <Switch
            label="Receives document expiry alert emails"
            checked={form.receives_alerts}
            onChange={(e) => set('receives_alerts', e.currentTarget.checked)}
          />
          {user && (
            <>
              <Switch
                label="Account active (can sign in)"
                checked={form.is_active}
                onChange={(e) => set('is_active', e.currentTarget.checked)}
              />
              {user.locked && (
                <Checkbox
                  label="Unlock account (locked after failed sign-ins)"
                  checked={form.unlock}
                  onChange={(e) => set('unlock', e.currentTarget.checked)}
                />
              )}
              {user.totp_enabled && (
                <Checkbox
                  label="Reset two-factor authentication (e.g. lost phone)"
                  checked={form.reset_2fa}
                  onChange={(e) => set('reset_2fa', e.currentTarget.checked)}
                />
              )}
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function EmployeesPage() {
  const [editing, setEditing] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: User[] }>('/users') });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Employees</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          New employee
        </Button>
      </Group>
      <Text c="dimmed" size="sm">
        Only employees listed here can sign in. Employees with the <IconBell size={13} /> bell receive the expiry alert emails.
      </Text>
      <Card withBorder p={0}>
        {isLoading ? (
          <Loader m="md" />
        ) : (
          <Table.ScrollContainer minWidth={700}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Role</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Alerts</Table.Th>
                  <Table.Th>2FA</Table.Th>
                  <Table.Th>Last sign-in</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.users.map((u) => (
                  <Table.Tr
                    key={u.id}
                    style={{ cursor: 'pointer', opacity: u.is_active ? 1 : 0.55 }}
                    onClick={() => {
                      setEditing(u);
                      setOpen(true);
                    }}
                  >
                    <Table.Td fw={500}>{u.name}</Table.Td>
                    <Table.Td>{u.email}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={u.role === 'admin' ? 'grape' : 'blue'}>
                        {u.role}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {!u.is_active ? (
                        <Badge color="gray">Disabled</Badge>
                      ) : u.locked ? (
                        <Badge color="red">Locked</Badge>
                      ) : (
                        <Badge color="teal" variant="light">
                          Active
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>{u.receives_alerts ? <IconBell size={16} color="var(--mantine-color-teal-6)" /> : '-'}</Table.Td>
                    <Table.Td>{u.totp_enabled ? 'On' : 'Off'}</Table.Td>
                    <Table.Td>{formatTimestamp(u.last_login_at)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
      <EmployeeModal user={editing} opened={open} onClose={() => setOpen(false)} />
    </Stack>
  );
}
