import { AppShell, Burger, Group, Menu, NavLink, Text, UnstyledButton, Avatar, Divider } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBuilding,
  IconChevronDown,
  IconFileDescription,
  IconGauge,
  IconLogout,
  IconPlane,
  IconPlaneDeparture,
  IconSettings,
  IconTrash,
  IconUserCircle,
  IconUsers,
  IconUsersGroup,
} from '@tabler/icons-react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { api, queryClient } from '../api';
import type { User } from '../types';
import { ErrorBoundary } from './ErrorBoundary';

/** The three primary modules, in this order. */
const MAIN_LINKS = [
  { to: '/trips', label: 'Trips', icon: IconPlaneDeparture },
  { to: '/companies', label: 'Companies', icon: IconBuilding },
  { to: '/travellers', label: 'Travellers', icon: IconUsersGroup },
];

const OTHER_LINKS = [{ to: '/', label: 'Dashboard', icon: IconGauge }];

const ADMIN_LINKS = [
  { to: '/trash', label: 'Trash', icon: IconTrash },
  { to: '/audit', label: 'Audit log', icon: IconFileDescription },
  { to: '/employees', label: 'Employees', icon: IconUsers },
  { to: '/settings', label: 'Alert settings', icon: IconSettings },
];

export function Layout({ user }: { user: User }) {
  const [opened, { toggle, close }] = useDisclosure();
  const { pathname } = useLocation();
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    queryClient.clear();
    queryClient.setQueryData(['me'], null);
  }

  const renderLink = (l: (typeof MAIN_LINKS)[number]) => (
    <NavLink
      key={l.to}
      component={Link}
      to={l.to}
      label={l.label}
      leftSection={<l.icon size={18} stroke={1.6} />}
      active={isActive(l.to)}
      onClick={close}
    />
  );

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 230, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <IconPlane size={22} color="var(--mantine-color-teal-6)" />
            <Text fw={700}>Syndic CRM</Text>
          </Group>
          <Menu position="bottom-end" width={200}>
            <Menu.Target>
              <UnstyledButton aria-label="Account menu">
                <Group gap={8}>
                  <Avatar size="sm" color="teal" radius="xl">
                    {user.name.slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Text size="sm" visibleFrom="xs">
                    {user.name}
                  </Text>
                  <IconChevronDown size={14} />
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.role === 'admin' ? 'Administrator' : 'Staff'}</Menu.Label>
              <Menu.Item component={Link} to="/account" leftSection={<IconUserCircle size={16} />}>
                My account
              </Menu.Item>
              <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={logout}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {MAIN_LINKS.map(renderLink)}
        <Divider my="sm" />
        {OTHER_LINKS.map(renderLink)}
        {user.role === 'admin' && (
          <>
            <Divider my="sm" label="Admin" labelPosition="left" />
            {ADMIN_LINKS.map(renderLink)}
          </>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        <ErrorBoundary key={pathname}>
          <Outlet />
        </ErrorBoundary>
      </AppShell.Main>
    </AppShell>
  );
}
