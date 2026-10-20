import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconCheck, IconPlus, IconSearch, IconSend, IconSparkles, IconX } from '@tabler/icons-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { api, notifyError, queryClient, useAppConfig } from '../api';

/** Content blocks as the Claude API returns them; only the fields the page reads. */
interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

interface PendingAction {
  id: string;
  name: string;
  summary: string;
}

interface ChatResponse {
  messages: ChatMessage[];
  pending?: PendingAction[];
  notice?: string;
}

interface ChatState {
  messages: ChatMessage[];
  pending: PendingAction[];
  notice: string | null;
}

const EMPTY: ChatState = { messages: [], pending: [], notice: null };
const STORAGE_KEY = 'syndic-assistant-chat';

const TOOL_LABELS: Record<string, string> = {
  search_trips: 'Searched trips',
  get_trip: 'Opened a trip',
  search_travellers: 'Searched travellers',
  get_traveller: 'Opened a traveller',
  search_companies: 'Searched companies',
  get_company: 'Opened a company',
  expiring_documents: 'Checked expiring documents',
  crm_overview: 'Checked the overview',
  create_trip: 'Create trip',
  add_itinerary_items: 'Add itinerary items',
  update_trip: 'Update trip',
  add_travellers_to_trip: 'Add travellers to trip',
  create_traveller: 'Create traveller',
  create_company: 'Create company',
};

const SUGGESTIONS = [
  'Which trips depart in the next 7 days?',
  'Which passports or visas expire in the next 60 days?',
  'Show all trips for a company and who is travelling',
  'Create a trip: KHI to DXB flight on 20 Nov at 09:30, hotel in Dubai until 23 Nov',
];

// The chat survives moving between pages until the tab is closed (per browser, never shared).
function loadChat(): ChatState {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    return saved ? { ...EMPTY, ...JSON.parse(saved) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function saveChat(state: ChatState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the chat still works, it just won't survive a page change.
  }
}

/** Markdown links to /trips/..., /travellers/... stay inside the app. */
const markdown: Components = {
  a: ({ href, children }) =>
    href?.startsWith('/') ? (
      <Anchor component={Link} to={href}>
        {children}
      </Anchor>
    ) : (
      <Anchor href={href} target="_blank" rel="noreferrer">
        {children}
      </Anchor>
    ),
  table: ({ children }) => (
    <Table.ScrollContainer minWidth={400}>
      <Table withTableBorder withColumnBorders striped fz="sm">
        {children}
      </Table>
    </Table.ScrollContainer>
  ),
  thead: ({ children }) => <Table.Thead>{children}</Table.Thead>,
  tbody: ({ children }) => <Table.Tbody>{children}</Table.Tbody>,
  tr: ({ children }) => <Table.Tr>{children}</Table.Tr>,
  th: ({ children }) => <Table.Th>{children}</Table.Th>,
  td: ({ children }) => <Table.Td>{children}</Table.Td>,
  code: ({ children }) => <Code>{children}</Code>,
};

function AssistantText({ text }: { text: string }) {
  return (
    <Box fz="sm" style={{ lineHeight: 1.55 }} className="assistant-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
        {text}
      </ReactMarkdown>
    </Box>
  );
}

export function AssistantPage() {
  const { assistant: enabled } = useAppConfig();
  const [chat, setChat] = useState<ChatState>(loadChat);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => saveChat(chat), [chat]);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [chat.messages.length, chat.pending.length, busy]);

  // Results of every tool call, to show whether a proposed change was approved.
  const results = new Map<string, Block>();
  for (const m of chat.messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
    }
  }

  async function send(body: { messages: ChatMessage[]; decisions?: Record<string, boolean> }, onError?: () => void) {
    setBusy(true);
    try {
      const res = await api<ChatResponse>('/assistant/chat', { body });
      setChat({ messages: res.messages, pending: res.pending ?? [], notice: res.notice ?? null });
      setDecisions({});
      // The assistant may have changed records shown elsewhere.
      if (body.decisions && Object.values(body.decisions).some(Boolean)) {
        for (const key of ['trips', 'trip', 'companies', 'company', 'clients', 'client', 'dashboard']) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }
    } catch (err) {
      notifyError(err);
      onError?.();
    } finally {
      setBusy(false);
    }
  }

  function ask(text: string) {
    const question = text.trim();
    if (!question || busy || chat.pending.length) return;
    const messages: ChatMessage[] = [...chat.messages, { role: 'user', content: question }];
    setChat({ ...chat, messages, notice: null });
    setInput('');
    send({ messages }, () => {
      // Put the question back so it can be retried.
      setChat((c) => ({ ...c, messages: c.messages.slice(0, -1) }));
      setInput(question);
    });
  }

  function decide(id: string, approved: boolean) {
    const next = { ...decisions, [id]: approved };
    setDecisions(next);
    if (chat.pending.every((p) => p.id in next)) send({ messages: chat.messages, decisions: next });
  }

  if (!enabled) {
    return (
      <Stack maw={720}>
        <Title order={2}>Assistant</Title>
        <Alert color="yellow" title="The assistant is not set up yet">
          An administrator can connect it under{' '}
          <Anchor component={Link} to="/settings">
            Settings → AI assistant
          </Anchor>{' '}
          by pasting an Anthropic API key.
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack h="calc(100dvh - 56px - 2 * var(--mantine-spacing-lg))" gap="sm" maw={1000}>
      <Group justify="space-between">
        <Group gap="xs">
          <IconSparkles size={24} color="var(--mantine-primary-color-filled)" />
          <Title order={2}>Assistant</Title>
        </Group>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconPlus size={14} />}
          disabled={busy || chat.messages.length === 0}
          onClick={() => {
            setChat(EMPTY);
            setDecisions({});
          }}
        >
          New chat
        </Button>
      </Group>

      <Card withBorder p={0} style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea h="100%" p="md">
          {chat.messages.length === 0 ? (
            <Stack align="center" py="xl" gap="md">
              <Text c="dimmed" ta="center" maw={520}>
                Ask about trips, travellers, companies or expiring documents, or ask it to create a trip, add itinerary
                items or add a traveller. Every change waits for your approval.
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }} w="100%" maw={720}>
                {SUGGESTIONS.map((s) => (
                  <UnstyledButton key={s} onClick={() => ask(s)}>
                    <Paper withBorder p="sm" radius="md">
                      <Text size="sm">{s}</Text>
                    </Paper>
                  </UnstyledButton>
                ))}
              </SimpleGrid>
            </Stack>
          ) : (
            <Stack gap="md">
              {chat.messages.map((m, i) => {
                if (m.role === 'user') {
                  if (typeof m.content !== 'string') return null; // tool results are shown on the calls themselves
                  return (
                    <Group key={i} justify="flex-end">
                      <Paper bg="var(--mantine-primary-color-filled)" c="var(--mantine-primary-color-contrast)" px="md" py="xs" radius="lg" maw="80%">
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                          {m.content}
                        </Text>
                      </Paper>
                    </Group>
                  );
                }
                const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
                return (
                  <Stack key={i} gap={6} maw="90%">
                    {blocks.map((b, j) => {
                      if (b.type === 'text' && b.text) return <AssistantText key={j} text={b.text} />;
                      if (b.type === 'tool_use' && b.name) {
                        const result = b.id ? results.get(b.id) : undefined;
                        const isChange = !b.name.startsWith('search') && !b.name.startsWith('get') && !['expiring_documents', 'crm_overview'].includes(b.name);
                        return (
                          <Group key={j} gap={6}>
                            <Badge
                              variant="light"
                              color={!isChange ? 'gray' : !result ? 'yellow' : result.is_error ? 'red' : 'mono'}
                              leftSection={!isChange ? <IconSearch size={11} /> : result && !result.is_error ? <IconCheck size={11} /> : undefined}
                              style={{ textTransform: 'none' }}
                            >
                              {TOOL_LABELS[b.name] ?? b.name}
                              {isChange && (result ? (result.is_error ? ' — not done' : ' — done') : ' — waiting for you')}
                            </Badge>
                          </Group>
                        );
                      }
                      return null;
                    })}
                  </Stack>
                );
              })}

              {chat.pending.length > 0 && !busy && (
                <Stack gap="xs">
                  {chat.pending.map((p) => (
                    <Paper key={p.id} withBorder p="sm" radius="md" style={{ borderColor: 'var(--mantine-color-yellow-6)' }}>
                      <Group justify="space-between" wrap="nowrap" align="flex-start">
                        <div>
                          <Text size="xs" fw={700} c="yellow.7" tt="uppercase">
                            Approve this change?
                          </Text>
                          <Text size="sm">{p.summary}</Text>
                        </div>
                        {p.id in decisions ? (
                          <Badge color={decisions[p.id] ? 'mono' : 'gray'}>{decisions[p.id] ? 'Approved' : 'Declined'}</Badge>
                        ) : (
                          <Group gap="xs" wrap="nowrap">
                            <Button size="xs" color="mono" leftSection={<IconCheck size={14} />} onClick={() => decide(p.id, true)}>
                              Approve
                            </Button>
                            <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => decide(p.id, false)}>
                              Decline
                            </Button>
                          </Group>
                        )}
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              )}

              {busy && (
                <Group gap="xs">
                  <Loader size="xs" type="dots" />
                  <Text size="sm" c="dimmed">
                    Working on it…
                  </Text>
                </Group>
              )}
              {chat.notice && (
                <Text size="sm" c="dimmed" fs="italic">
                  {chat.notice}
                </Text>
              )}
            </Stack>
          )}
          <div ref={bottom} />
        </ScrollArea>
      </Card>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <Textarea
            style={{ flex: 1 }}
            placeholder={chat.pending.length ? 'Approve or decline the change above first' : 'Ask a question or give a task… (Enter to send, Shift+Enter for a new line)'}
            autosize
            minRows={1}
            maxRows={6}
            value={input}
            disabled={chat.pending.length > 0}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
          />
          <Button type="submit" leftSection={<IconSend size={16} />} loading={busy} disabled={!input.trim() || chat.pending.length > 0}>
            Send
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          Powered by Claude. Answers come from your CRM data; check important details. Passport and ID numbers are never shared with the assistant.
        </Text>
      </form>
    </Stack>
  );
}
