import Anthropic, { toFile } from '@anthropic-ai/sdk';
import ExcelJS from 'exceljs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { currentUser } from '../auth/session.js';
import { assistantKey } from '../assistant/key.js';
import { describeAction, runTool, ToolError, toolPermissionProblem, toolsFor, WRITE_TOOLS } from '../assistant/tools.js';
import { batchContext, BULK_WRITE_TOOLS, previewBulk, WRITE_ORDER, type BatchContext } from '../assistant/bulk.js';
import { todayInTz } from '../lib/dates.js';
import { HttpError, parseId } from '../lib/http.js';
import { createChat, getChat, hideChat, listChats, renameChat, saveChat, titleFrom } from '../db/chats.js';
import { audit, timezone } from '../db/repo.js';
import { requirePermission } from '../auth/permissions.js';

/**
 * The CRM assistant (Claude). The browser keeps the conversation and sends it
 * back each turn; the server runs Claude's tool calls. Look-ups run straight
 * away. Changes pause the loop and come back as `pending` actions, each with a
 * preview of every row; the employee's decisions are sent with the next
 * request, and only approved actions run.
 */
export const assistantRouter = Router();

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

// One client per key, so a key saved in Settings takes effect on the next message.
let client: { key: string; anthropic: Anthropic } | null = null;
function anthropicFor(key: string): Anthropic {
  if (client?.key !== key) client = { key, anthropic: new Anthropic({ apiKey: key }) };
  return client.anthropic;
}

async function requireAnthropic(): Promise<Anthropic> {
  const found = await assistantKey();
  if (!found) throw new HttpError(503, 'The assistant is not set up. An administrator can add the API key under Settings.');
  return anthropicFor(found.key);
}

/** Look-up rounds Claude may take for one message before the server stops it. */
const MAX_ROUNDS = 15;

function systemPrompt(): string {
  return `You are the assistant inside Syndic CRM, the internal system of a travel agency. You help agency employees with trips, companies and travellers, and you can add and change records in the CRM.

Today is ${todayInTz(timezone())} (time zone ${timezone()}).

How to work:
- Answer from the CRM's data. Use the tools to look things up; never guess names, dates, references or ids. If a search finds several possible matches, ask which one is meant.
- When the employee asks you to add or change something, call the matching tool directly. The app shows them a preview of every row and nothing is saved until they approve, so you do not need to ask "shall I?" first. If a required detail is missing (for example the departure date of a flight), ask for it instead of inventing it.
- Attached sheets (Excel or CSV, shown to you as text), PDFs and images: read them, work out which columns mean what (given name, last name, date of birth, passport number and expiry, company, phone, email and so on) and add or update the records with as few tool calls as possible: put every row in one create_travellers / update_travellers / create_companies call (split only above 500 rows). Before adding travellers, search for ones that may already exist and update those instead. Create any missing companies in the same turn with create_companies; travellers can then refer to them by company_name. Convert dates to YYYY-MM-DD. If a column's meaning is unclear, ask before saving.
- Lists you add go in one action; after it runs, report how many were added or changed and list any skipped rows with the reason.
- You can move trips, companies and travellers to the Trash (they can be restored). You only have the tools this employee's permissions allow; if they ask for something you have no tool for, say they need an administrator to give them that permission. You cannot delete anything permanently, send emails, or read passport and ID numbers already saved in the CRM (you can save numbers the employee gives you).
- If an action is declined, accept it and ask what they would like instead.
- When you mention a record, link it with its id from the tool results: [TRP-2026-00012](/trips/12), [HINA RAZA](/travellers/5), [ABC CORPORATION](/companies/3).
- Be brief and practical. Use short lists or tables for several items. Give dates like 20 Nov 2026 and always include trip references (TRP-...) when you mention trips.`;
}

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() })).min(1).max(400),
  /** tool_use id -> approved? for the pending actions in the last assistant message */
  decisions: z.record(z.boolean()).optional(),
  /** The saved chat this continues; a new one is saved when left out. */
  chatId: z.coerce.number().int().positive().optional(),
  /** Attachment file id -> file name, shown with the saved chat. */
  files: z.record(z.string().max(300)).optional(),
});

function toolUses(message: MessageParam | undefined): ToolUse[] {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter((b): b is ToolUse => (b as { type?: string }).type === 'tool_use');
}

/** Look-ups run together; approved changes run one after another (companies before the travellers that use them). */
async function runTools(uses: ToolUse[], decisions: Record<string, boolean>, req: Parameters<typeof currentUser>[0]): Promise<ToolResult[]> {
  const user = currentUser(req);
  const ctx: BatchContext = batchContext(uses);
  const one = async (use: ToolUse): Promise<ToolResult> => {
    if (WRITE_TOOLS.has(use.name) && decisions[use.id] !== true) {
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'The employee declined this action. Nothing was changed.' };
    }
    try {
      const result = await runTool(use.name, use.input, user, ctx);
      return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) };
    } catch (err) {
      const message = err instanceof ToolError || err instanceof HttpError ? err.message : 'The CRM could not complete this request.';
      if (!(err instanceof ToolError)) console.error(`[assistant] ${use.name} failed:`, err);
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: message };
    }
  };
  const reads = uses.filter((u) => !WRITE_TOOLS.has(u.name));
  const writes = uses
    .filter((u) => WRITE_TOOLS.has(u.name))
    .sort((a, b) => (WRITE_ORDER.indexOf(a.name) + 1 || 99) - (WRITE_ORDER.indexOf(b.name) + 1 || 99));
  const results = new Map<string, ToolResult>();
  for (const r of await Promise.all(reads.map(one))) results.set(r.tool_use_id, r);
  for (const w of writes) results.set(w.id, await one(w));
  // Results go back in the order Claude made the calls.
  return uses.map((u) => results.get(u.id)!);
}

assistantRouter.post('/chat', requirePermission('assistant', 'view'), async (req, res) => {
  const anthropic = await requireAnthropic();
  const body = bodySchema.parse(req.body);
  const messages = body.messages as MessageParam[];
  const user = currentUser(req);

  // Only the employee who had a chat can continue it (admins read others' chats, read-only).
  let chatId = body.chatId ?? null;
  let files = body.files ?? {};
  if (chatId) {
    const chat = await getChat(chatId);
    if (!chat) throw new HttpError(404, 'Chat not found');
    if (chat.user_id !== user.id) throw new HttpError(403, "This is another employee's chat; you can read it but not continue it.");
    files = { ...chat.files, ...files };
  }

  /** Saves the conversation (creating the chat on its first reply) and answers the browser. */
  const respond = async (out: { messages: MessageParam[]; pending?: unknown[]; notice?: string }) => {
    const state = { messages: out.messages, pending: out.pending ?? [], notice: out.notice ?? null, files };
    if (chatId) await saveChat(chatId, state);
    else chatId = await createChat(user.id, titleFrom(firstQuestion(out.messages)), state);
    res.json({ ...out, chatId });
  };

  // Answering pending actions: run the last assistant turn's tool calls now.
  const waiting = toolUses(messages.at(-1));
  if (waiting.length) {
    messages.push({ role: 'user', content: await runTools(waiting, body.decisions ?? {}, req) });
  } else if (messages.at(-1)?.role !== 'user') {
    throw new HttpError(400, 'Send a message first');
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      // Streamed so long answers (e.g. a whole sheet of travellers in one action) don't hit a request timeout.
      response = await anthropic.beta.messages
        .stream({
          model: config.assistant.model,
          max_tokens: 64000,
          output_config: { effort: 'medium' },
          // If a safety check declines a request, Anthropic retries it on a suitable model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          // Caches the system prompt, tools and conversation so far between turns.
          cache_control: { type: 'ephemeral' },
          system: systemPrompt(),
          tools: toolsFor(currentUser(req)),
          messages,
        })
        .finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The assistant is busy. Try again in a moment.');
      if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'The assistant API key is not valid. An administrator can replace it under Settings.');
      if (err instanceof Anthropic.BadRequestError) {
        console.error('[assistant] request rejected:', err.message);
        throw new HttpError(400, 'The assistant could not read this conversation. Start a new chat.');
      }
      if (err instanceof Anthropic.APIError) {
        console.error('[assistant] API error:', err.status, err.message);
        throw new HttpError(502, 'The assistant is unavailable right now. Try again shortly.');
      }
      throw err;
    }

    // Keep every block (including thinking) exactly as returned, so the next turn can continue it.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      await respond({ messages, notice: 'The assistant declined this request.' });
      return;
    }
    if (response.stop_reason === 'max_tokens') {
      // A cut-off reply may hold half a tool call; never run it.
      await respond({ messages: messages.slice(0, -1), notice: 'The reply was too long and was stopped. Ask for fewer rows at a time.' });
      return;
    }
    if (response.stop_reason !== 'tool_use') {
      await respond({ messages });
      return;
    }

    const uses = toolUses(messages.at(-1));
    const writes = uses.filter((u) => WRITE_TOOLS.has(u.name));
    if (writes.length) {
      // Changes wait for the employee, with a preview of every row. Look-ups in the same turn run together with them afterwards.
      const ctx = batchContext(uses);
      const user = currentUser(req);
      const pending = [];
      for (const u of writes) {
        const blocked = toolPermissionProblem(u.name, user);
        const preview = blocked
          ? { columns: ['Change'], rows: [{ cells: [u.name.replace(/_/g, ' ')], problem: blocked }] }
          : BULK_WRITE_TOOLS.has(u.name)
            ? await previewBulk(u.name, u.input as Record<string, unknown>, user, ctx)
            : null;
        pending.push({ id: u.id, name: u.name, summary: describeAction(u.name, u.input as Record<string, unknown>), preview });
      }
      await respond({ messages, pending });
      return;
    }
    messages.push({ role: 'user', content: await runTools(uses, {}, req) });
  }

  await respond({ messages, notice: 'The assistant stopped after many look-ups. Ask a narrower question.' });
});

/** The text of the first thing the employee asked, for the chat's title. */
function firstQuestion(messages: MessageParam[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  const text = first.content.find((b) => b.type === 'text');
  return text && 'text' in text ? text.text : 'Attached files';
}

// ---------------------------------------------------------------- saved chats

const listSchema = z.object({
  /** Admins: every employee's chats. */
  all: z.enum(['1', 'true']).optional(),
  userId: z.coerce.number().int().positive().optional(),
  q: z.string().max(200).optional(),
});

assistantRouter.get('/chats', requirePermission('assistant', 'view'), async (req, res) => {
  const user = currentUser(req);
  const query = listSchema.parse(req.query);
  const all = Boolean(query.all) && user.role === 'admin';
  res.json({ chats: await listChats({ userId: user.id, all, ofUser: all ? query.userId : null, q: query.q }) });
});

/** The employee's own chat, or any chat for an admin (read-only when it isn't theirs). */
async function readableChat(req: Parameters<typeof currentUser>[0], rawId: unknown) {
  const user = currentUser(req);
  const chat = await getChat(parseId(rawId));
  const mine = chat && chat.user_id === user.id && !chat.hidden;
  if (!chat || (!mine && user.role !== 'admin')) throw new HttpError(404, 'Chat not found');
  return { chat, mine: Boolean(mine) };
}

assistantRouter.get('/chats/:id', requirePermission('assistant', 'view'), async (req, res) => {
  const { chat, mine } = await readableChat(req, req.params.id);
  if (!mine) await audit(currentUser(req), 'assistant_chat_viewed', 'user', chat.user_id, `chat #${chat.id} "${chat.title}"`);
  res.json({ chat, readOnly: !mine });
});

assistantRouter.put('/chats/:id', requirePermission('assistant', 'view'), async (req, res) => {
  const { chat, mine } = await readableChat(req, req.params.id);
  if (!mine) throw new HttpError(403, "You can only rename your own chats.");
  const { title } = z.object({ title: z.string().trim().min(1, 'is required').max(120) }).parse(req.body);
  await renameChat(chat.id, title);
  res.json({ ok: true });
});

/** Removes the chat from the employee's list; admins can still read it. */
assistantRouter.delete('/chats/:id', requirePermission('assistant', 'view'), async (req, res) => {
  const { chat, mine } = await readableChat(req, req.params.id);
  if (!mine) throw new HttpError(403, 'You can only delete your own chats.');
  await hideChat(chat.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- attachments

/** Largest sheet text sent to Claude (about 500 rows of a wide sheet). */
const MAX_SHEET_CHARS = 400_000;

const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(config.maxUploadMb, 15) * 1024 * 1024, files: 1 } });

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return '';
  }
  return String(value).trim();
}

/** Every sheet of a workbook as CSV text, each under its own heading. */
async function workbookText(buffer: Buffer): Promise<string> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const parts: string[] = [];
  book.eachSheet((ws) => {
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map((v) => csvCell(cellText(v)));
      if (values.some(Boolean)) lines.push(values.join(','));
    });
    if (lines.length) parts.push(`Sheet: ${ws.name} (${lines.length} rows including the header)\n${lines.join('\n')}`);
  });
  return parts.join('\n\n');
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/**
 * Uploads one attachment to Anthropic (kept 7 days) and returns the content
 * block the browser puts in its next message. Sheets are turned into text first.
 */
assistantRouter.post('/attachments', requirePermission('assistant', 'view'), attachmentUpload.single('file'), async (req, res) => {
  const anthropic = await requireAnthropic();
  const file = req.file;
  if (!file) throw new HttpError(400, 'Choose a file to attach.');
  const name = file.originalname || 'attachment';
  const ext = name.toLowerCase().split('.').pop() ?? '';

  let upload: { data: Buffer; type: string; name: string; kind: 'document' | 'image' };
  if (ext === 'xlsx' || ext === 'xlsm') {
    let text: string;
    try {
      text = await workbookText(file.buffer);
    } catch {
      throw new HttpError(400, 'This Excel file could not be read. Save it as .xlsx (or CSV) and try again.');
    }
    if (!text.trim()) throw new HttpError(400, 'The sheet is empty.');
    if (text.length > MAX_SHEET_CHARS) throw new HttpError(400, 'This sheet is too large for one message. Split it into smaller sheets (about 500 rows each).');
    upload = { data: Buffer.from(text, 'utf8'), type: 'text/plain', name: `${name}.txt`, kind: 'document' };
  } else if (ext === 'xls') {
    throw new HttpError(400, 'Old .xls files are not supported. Open it in Excel and save it as .xlsx or CSV.');
  } else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    const text = file.buffer.toString('utf8');
    if (text.length > MAX_SHEET_CHARS) throw new HttpError(400, 'This file is too large for one message. Split it into smaller files (about 500 rows each).');
    upload = { data: file.buffer, type: 'text/plain', name, kind: 'document' };
  } else if (ext === 'pdf') {
    upload = { data: file.buffer, type: 'application/pdf', name, kind: 'document' };
  } else if (IMAGE_TYPES[ext]) {
    upload = { data: file.buffer, type: IMAGE_TYPES[ext], name, kind: 'image' };
  } else {
    throw new HttpError(400, 'Attach an Excel (.xlsx), CSV, PDF or image (PNG, JPG, WebP) file.');
  }

  let fileId: string;
  try {
    const uploaded = await anthropic.files.upload({
      file: await toFile(upload.data, upload.name, { type: upload.type }),
      expires_in_seconds: 7 * 24 * 3600,
    });
    fileId = uploaded.id;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'The assistant API key is not valid. An administrator can replace it under Settings.');
    if (err instanceof Anthropic.APIError) {
      console.error('[assistant] file upload failed:', err.status, err.message);
      throw new HttpError(502, 'The file could not be sent to the assistant. Try again shortly.');
    }
    throw err;
  }

  const block =
    upload.kind === 'image'
      ? { type: 'image', source: { type: 'file', file_id: fileId } }
      : { type: 'document', source: { type: 'file', file_id: fileId }, title: name };
  res.status(201).json({ block, name, kind: ext === 'xlsx' || ext === 'xlsm' || ext === 'csv' || ext === 'tsv' ? 'sheet' : upload.kind === 'image' ? 'image' : 'pdf' });
});
