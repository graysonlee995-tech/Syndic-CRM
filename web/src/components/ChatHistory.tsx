import { useMemo, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Loader, Menu, ScrollArea, SegmentedControl, Select, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconDots, IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, notifyError, queryClient, useMe } from '../api';

export interface ChatSummary {
  id: number;
  title: string;
  user_id: number | null;
  user_name: string | null;
  /** Deleted by its owner (only admins still see it). */
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

const DAY = 86_400_000;

/** Today / Previous 7 days / Previous 30 days / Older, like other chat apps. */
function groupOf(updatedAt: string): string {
  const age = Date.now() - Date.parse(updatedAt);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (Date.parse(updatedAt) >= midnight.getTime()) return 'Today';
  if (age < 7 * DAY) return 'Previous 7 days';
  if (age < 30 * DAY) return 'Previous 30 days';
  return 'Older';
}

/**
 * The list of saved chats on the left of the assistant. Each employee sees
 * their own; admins can switch to every employee's chats (read-only) and
 * filter them by employee.
 */
export function ChatHistory({ activeId, onOpen, onNew }: { activeId: number | null; onOpen: (id: number) => void; onNew: () => void }) {
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [userId, setUserId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [debouncedQ] = useDebouncedValue(q, 300);

  const params = new URLSearchParams();
  if (scope === 'all') params.set('all', '1');
  if (scope === 'all' && userId) params.set('userId', userId);
  if (debouncedQ.trim()) params.set('q', debouncedQ.trim());
  const { data, isLoading } = useQuery({
    queryKey: ['assistant-chats', params.toString()],
    queryFn: () => api<{ chats: ChatSummary[] }>(`/assistant/chats?${params}`),
  });
  // Everyone who has chats, for the admin's employee filter.
  const everyone = useQuery({
    queryKey: ['assistant-chats', 'all'],
    queryFn: () => api<{ chats: ChatSummary[] }>('/assistant/chats?all=1'),
    enabled: isAdmin && scope === 'all',
  });
  const people = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of everyone.data?.chats ?? []) if (c.user_id) seen.set(String(c.user_id), c.user_name ?? `Employee #${c.user_id}`);
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [everyone.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['assistant-chats'] });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: number; title: string }) => api(`/assistant/chats/${id}`, { method: 'PUT', body: { title } }),
    onSuccess: refresh,
    onError: notifyError,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/assistant/chats/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      refresh();
      if (id === activeId) onNew();
    },
    onError: notifyError,
  });

  const groups = new Map<string, ChatSummary[]>();
  for (const c of data?.chats ?? []) {
    const g = groupOf(c.updated_at);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }

  return (
    <Stack gap="xs" h="100%">
      <Button leftSection={<IconPlus size={16} />} variant="default" onClick={onNew} fullWidth>
        New chat
      </Button>
      {isAdmin && (
        <SegmentedControl
          size="xs"
          value={scope}
          onChange={(v) => {
            setScope(v as 'mine' | 'all');
            setUserId(null);
          }}
          data={[
            { value: 'mine', label: 'My chats' },
            { value: 'all', label: 'All employees' },
          ]}
        />
      )}
      {scope === 'all' && (
        <Select size="xs" placeholder="All employees" clearable searchable data={people} value={userId} onChange={setUserId} />
      )}
      <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder="Search chats" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <ScrollArea style={{ flex: 1 }} offsetScrollbars>
        {isLoading ? (
          <Loader size="sm" m="sm" />
        ) : !data?.chats.length ? (
          <Text size="sm" c="dimmed" p="xs">
            {q ? 'No chats match.' : 'No chats yet.'}
          </Text>
        ) : (
          <Stack gap="sm">
            {[...groups].map(([group, chats]) => (
              <Stack key={group} gap={2}>
                <Text size="xs" c="dimmed" fw={600} px={6}>
                  {group}
                </Text>
                {chats.map((c) => {
                  const mine = c.user_id === me?.id && !c.hidden;
                  const active = c.id === activeId;
                  return (
                    <Group
                      key={c.id}
                      gap={2}
                      wrap="nowrap"
                      px={6}
                      py={4}
                      style={{ borderRadius: 6, background: active ? 'var(--mantine-color-default-hover)' : undefined }}
                    >
                      <UnstyledButton onClick={() => onOpen(c.id)} style={{ flex: 1, minWidth: 0 }} aria-current={active || undefined}>
                        <Text size="sm" truncate fw={active ? 600 : 400}>
                          {c.title}
                        </Text>
                        {scope === 'all' && (
                          <Group gap={4} wrap="nowrap">
                            <Text size="xs" c="dimmed" truncate>
                              {c.user_name ?? 'Former employee'}
                            </Text>
                            {c.hidden && (
                              <Badge size="xs" color="gray" variant="light" style={{ textTransform: 'none' }}>
                                deleted by user
                              </Badge>
                            )}
                          </Group>
                        )}
                      </UnstyledButton>
                      {mine && (
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Chat options">
                              <IconDots size={14} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconPencil size={14} />}
                              onClick={() => {
                                const title = window.prompt('Rename chat', c.title)?.trim();
                                if (title && title !== c.title) rename.mutate({ id: c.id, title });
                              }}
                            >
                              Rename
                            </Menu.Item>
                            <Menu.Item
                              color="red"
                              leftSection={<IconTrash size={14} />}
                              onClick={() => {
                                if (window.confirm(`Delete "${c.title}" from your chats?`)) remove.mutate(c.id);
                              }}
                            >
                              Delete
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      )}
                    </Group>
                  );
                })}
              </Stack>
            ))}
          </Stack>
        )}
      </ScrollArea>
    </Stack>
  );
}
