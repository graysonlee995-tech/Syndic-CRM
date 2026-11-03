import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  CloseButton,
  Code,
  FileButton,
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
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconCheck,
  IconFileSpreadsheet,
  IconFileTypePdf,
  IconPaperclip,
  IconPhoto,
  IconPlus,
  IconSearch,
  IconSend,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
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
  /** Attachments: document / image blocks that point at a file uploaded to Anthropic. */
  title?: string;
  source?: { type: string; file_id?: string };
}

/** A file attached to the next message, already uploaded. */
interface Attachment {
  block: Block;
  name: string;
  kind: 'sheet' | 'pdf' | 'image';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

interface PendingAction {
  id: string;
  name: string;
  summary: string;
  /** Every row the action will save; rows with a problem are skipped. */
  preview?: { columns: string[]; rows: { cells: string[]; problem?: string }[] } | null;
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
  /** Attachment file id -> file name, to show which files a message carried. */
  files: Record<string, string>;
}

const EMPTY: ChatState = { messages: [], pending: [], notice: null, files: {} };
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
  add_itinerary_items: 'Add itinerary items',
  update_trip: 'Update trip',
  add_travellers_to_trip: 'Add travellers to trip',
  create_travellers: 'Add travellers',
  update_travellers: 'Update travellers',
  update_documents: 'Update documents',
  create_companies: 'Add companies',
  update_companies: 'Update companies',
  create_trips: 'Create trips',
  set_quality_check: 'Quality check',
  move_to_trash: 'Move to Trash',
};

const ACCEPT = '.xlsx,.xlsm,.csv,.tsv,.txt,.pdf,.png,.jpg,.jpeg,.webp,.gif';
const KIND_ICONS = { sheet: IconFileSpreadsheet, pdf: IconFileTypePdf, image: IconPhoto } as const;

const SUGGESTIONS = [
  'Which trips depart in the next 7 days?',
  'Attach a sheet and say: add every traveller in this sheet',
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

/** What an action will save, row by row; rows with a problem are skipped. */
function PreviewTable({ preview }: { preview: NonNullable<PendingAction['preview']> }) {
  const skipped = preview.rows.filter((r) => r.problem).length;
  const saved = preview.rows.length - skipped;
  return (
    <Stack gap={4} mt={6}>
      <Text size="xs" c="dimmed">
        {saved} will be saved{skipped ? `, ${skipped} skipped` : ''}
      </Text>
      <ScrollArea.Autosize mah={320}>
        <Table withTableBorder striped fz="xs" verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={32}>#</Table.Th>
              {preview.columns.map((c) => (
                <Table.Th key={c}>{c}</Table.Th>
              ))}
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {preview.rows.map((r, i) => (
              <Table.Tr key={i} style={r.problem ? { opacity: 0.75 } : undefined}>
                <Table.Td c="dimmed">{i + 1}</Table.Td>
                {r.cells.map((c, j) => (
                  <Table.Td key={j}>{c || '-'}</Table.Td>
                ))}
                <Table.Td>
                  {r.problem ? (
                    <Text size="xs" c="red">
                      Skipped: {r.problem}
                    </Text>
                  ) : (
                    <IconCheck size={14} color="var(--mantine-color-green-6)" />
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
    </Stack>
  );
}

export function AssistantPage() {
  const { assistant: enabled } = useAppConfig();
  const [chat, setChat] = useState<ChatState>(loadChat);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveChat(chat);
  }, [chat]);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not return anything but a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages.length, chat.pending.length, busy]);

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
      setChat((c) => ({ ...c, messages: res.messages, pending: res.pending ?? [], notice: res.notice ?? null }));
      setDecisions({});
      // The assistant may have changed records shown elsewhere.
      if (body.decisions && Object.values(body.decisions).some(Boolean)) {
        for (const key of ['trips', 'trip', 'companies', 'company', 'clients', 'client', 'dashboard', 'quality', 'trash']) {
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

  async function attach(files: File[]) {
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        const data = new FormData();
        data.append('file', file);
        const res = await api<Attachment>('/assistant/attachments', { form: data });
        setAttachments((a) => [...a, res]);
      } catch (err) {
        notifyError(err);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function ask(text: string) {
    const question = text.trim() || (attachments.length ? 'Please read the attached file(s).' : '');
    if (!question || busy || uploading || chat.pending.length) return;
    const sent = attachments;
    const content: ChatMessage['content'] = sent.length ? [...sent.map((a) => a.block), { type: 'text', text: question }] : question;
    const files = { ...chat.files };
    for (const a of sent) if (a.block.source?.file_id) files[a.block.source.file_id] = a.name;
    const messages: ChatMessage[] = [...chat.messages, { role: 'user', content }];
    setChat({ ...chat, messages, notice: null, files });
    setInput('');
    setAttachments([]);
    send({ messages }, () => {
      // Put the question and files back so they can be retried.
      setChat((c) => ({ ...c, messages: c.messages.slice(0, -1) }));
      setInput(question);
      setAttachments(sent);
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
            setAttachments([]);
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
                  const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content } as Block] : m.content;
                  if (parts.some((b) => b.type === 'tool_result')) return null; // tool results are shown on the calls themselves
                  const files = parts.filter((b) => b.type === 'document' || b.type === 'image');
                  const said = parts
                    .filter((b) => b.type === 'text' && b.text)
                    .map((b) => b.text)
                    .join('\n');
                  return (
                    <Stack key={i} gap={4} align="flex-end">
                      {files.length > 0 && (
                        <Group gap={6} justify="flex-end">
                          {files.map((f, k) => {
                            const Icon = f.type === 'image' ? IconPhoto : /\.(xlsx|xlsm|csv|tsv)$/i.test(f.title ?? '') ? IconFileSpreadsheet : IconFileTypePdf;
                            return (
                              <Badge key={k} variant="default" leftSection={<Icon size={12} />} style={{ textTransform: 'none' }}>
                                {f.title ?? (f.source?.file_id && chat.files[f.source.file_id]) ?? 'Attachment'}
                              </Badge>
                            );
                          })}
                        </Group>
                      )}
                      {said && (
                        <Paper bg="var(--mantine-primary-color-filled)" c="var(--mantine-primary-color-contrast)" px="md" py="xs" radius="lg" maw="80%">
                          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                            {said}
                          </Text>
                        </Paper>
                      )}
                    </Stack>
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
                              color={!isChange ? 'gray' : !result ? 'yellow' : result.is_error ? 'red' : 'green'}
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
                  {chat.pending.map((p) => {
                    const buttons =
                      p.id in decisions ? (
                        <Badge color={decisions[p.id] ? 'green' : 'gray'}>{decisions[p.id] ? 'Approved' : 'Declined'}</Badge>
                      ) : (
                        <Group gap="xs" wrap="nowrap">
                          <Button size="xs" leftSection={<IconCheck size={14} />} onClick={() => decide(p.id, true)}>
                            {p.preview && p.preview.rows.length > 1 ? 'Approve all' : 'Approve'}
                          </Button>
                          <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => decide(p.id, false)}>
                            Decline
                          </Button>
                        </Group>
                      );
                    return (
                      <Paper key={p.id} withBorder p="sm" radius="md" style={{ borderColor: 'var(--mantine-color-yellow-6)' }}>
                        <Group justify="space-between" wrap="nowrap" align="flex-start">
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <Text size="xs" fw={700} c="yellow.7" tt="uppercase">
                              Approve this change?
                            </Text>
                            <Text size="sm">{p.summary}</Text>
                          </div>
                          {/* With a preview table the buttons go underneath it, so they never get pushed off narrow screens. */}
                          {!p.preview && buttons}
                        </Group>
                        {p.preview && (
                          <>
                            <PreviewTable preview={p.preview} />
                            <Group justify="flex-end" mt="xs">
                              {buttons}
                            </Group>
                          </>
                        )}
                      </Paper>
                    );
                  })}
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
        {(attachments.length > 0 || uploading > 0) && (
          <Group gap={6} mb={6}>
            {attachments.map((a, k) => {
              const Icon = KIND_ICONS[a.kind];
              return (
                <Badge
                  key={k}
                  variant="default"
                  size="lg"
                  leftSection={<Icon size={14} />}
                  rightSection={
                    <CloseButton size="xs" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((all) => all.filter((_, j) => j !== k))} />
                  }
                  style={{ textTransform: 'none' }}
                >
                  {a.name}
                </Badge>
              );
            })}
            {uploading > 0 && (
              <Group gap={4}>
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  Attaching…
                </Text>
              </Group>
            )}
          </Group>
        )}
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <FileButton multiple accept={ACCEPT} onChange={(files) => files.length && attach(files)} disabled={busy || chat.pending.length > 0}>
            {(props) => (
              <Tooltip label="Attach Excel, CSV, PDF or image files">
                <ActionIcon {...props} variant="default" size={36} aria-label="Attach files">
                  <IconPaperclip size={18} />
                </ActionIcon>
              </Tooltip>
            )}
          </FileButton>
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
          <Button
            type="submit"
            leftSection={<IconSend size={16} />}
            loading={busy}
            disabled={(!input.trim() && !attachments.length) || uploading > 0 || chat.pending.length > 0}
          >
            Send
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          Powered by Claude. Answers come from your CRM data; check important details. Attached files are sent to Claude to read. Passport and ID
          numbers already saved in the CRM are never shared with the assistant.
        </Text>
      </form>
    </Stack>
  );
}
