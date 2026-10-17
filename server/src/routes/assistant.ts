import Anthropic from '@anthropic-ai/sdk';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { currentUser } from '../auth/session.js';
import { assistantKey } from '../assistant/key.js';
import { describeAction, runTool, ToolError, TOOLS, WRITE_TOOLS } from '../assistant/tools.js';
import { todayInTz } from '../lib/dates.js';
import { HttpError } from '../lib/http.js';

/**
 * The CRM assistant (Claude). The browser keeps the conversation and sends it
 * back each turn; the server runs Claude's tool calls. Look-ups run straight
 * away. Changes pause the loop and come back as `pending` actions; the
 * employee's decisions are sent with the next request, and only approved
 * actions run.
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

/** Look-up rounds Claude may take for one message before the server stops it. */
const MAX_ROUNDS = 10;

function systemPrompt(): string {
  return `You are the assistant inside Syndic CRM, the internal system of a travel agency in Pakistan. You help agency employees with trips, companies and travellers.

Today is ${todayInTz(config.timezone)} (time zone ${config.timezone}).

How to work:
- Answer from the CRM's data. Use the tools to look things up; never guess names, dates, references or ids. If a search finds several possible matches, ask which one is meant.
- When the employee asks you to create or change something, call the matching tool directly. The app shows them a confirmation card and nothing is saved until they approve, so you do not need to ask "shall I?" first. If a required detail is missing (for example the departure date of a flight), ask for it instead of inventing it.
- If an action is declined, accept it and ask what they would like instead.
- You cannot delete records, upload files, send emails or see passport and ID numbers; say so if asked.
- When you mention a record, link it with its id from the tool results: [TRP-2026-00012](/trips/12), [Hina Raza](/travellers/5), [ABC Corporation](/companies/3).
- Be brief and practical. Use short lists or tables for several items. Give dates like 20 Nov 2026 and always include trip references (TRP-...) when you mention trips.`;
}

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() })).min(1).max(400),
  /** tool_use id -> approved? for the pending actions in the last assistant message */
  decisions: z.record(z.boolean()).optional(),
});

function toolUses(message: MessageParam | undefined): ToolUse[] {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter((b): b is ToolUse => (b as { type?: string }).type === 'tool_use');
}

async function runTools(uses: ToolUse[], decisions: Record<string, boolean>, req: Parameters<typeof currentUser>[0]): Promise<ToolResult[]> {
  const user = currentUser(req);
  return Promise.all(
    uses.map(async (use): Promise<ToolResult> => {
      if (WRITE_TOOLS.has(use.name) && decisions[use.id] !== true) {
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'The employee declined this action. Nothing was changed.' };
      }
      try {
        const result = await runTool(use.name, use.input, user);
        return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) };
      } catch (err) {
        const message = err instanceof ToolError || err instanceof HttpError ? err.message : 'The CRM could not complete this request.';
        if (!(err instanceof ToolError)) console.error(`[assistant] ${use.name} failed:`, err);
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: message };
      }
    }),
  );
}

assistantRouter.post('/chat', async (req, res) => {
  const found = await assistantKey();
  if (!found) throw new HttpError(503, 'The assistant is not set up. An administrator can add the API key under Settings.');
  const anthropic = anthropicFor(found.key);
  const body = bodySchema.parse(req.body);
  const messages = body.messages as MessageParam[];

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
      response = await anthropic.beta.messages.create({
        model: config.assistant.model,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        // If a safety check declines a request, Anthropic retries it on a suitable model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // Caches the system prompt, tools and conversation so far between turns.
        cache_control: { type: 'ephemeral' },
        system: systemPrompt(),
        tools: TOOLS,
        messages,
      });
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
      res.json({ messages, notice: 'The assistant declined this request.' });
      return;
    }
    if (response.stop_reason !== 'tool_use') {
      res.json({ messages });
      return;
    }

    const uses = toolUses(messages.at(-1));
    const writes = uses.filter((u) => WRITE_TOOLS.has(u.name));
    if (writes.length) {
      // Changes wait for the employee. Look-ups in the same turn run together with them afterwards.
      res.json({
        messages,
        pending: writes.map((u) => ({ id: u.id, name: u.name, summary: describeAction(u.name, u.input as Record<string, unknown>) })),
      });
      return;
    }
    messages.push({ role: 'user', content: await runTools(uses, {}, req) });
  }

  res.json({ messages, notice: 'The assistant stopped after many look-ups. Ask a narrower question.' });
});
