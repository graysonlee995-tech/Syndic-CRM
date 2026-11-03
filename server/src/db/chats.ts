import { insert, one, query, run } from './index.js';
import type { Bindable } from './repo.js';

/**
 * Saved assistant conversations. Each belongs to the employee who had it;
 * admins can read everyone's. Deleting only hides a chat from its owner.
 */

export interface ChatSummary {
  id: number;
  title: string;
  user_id: number | null;
  user_name: string | null;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChatRow extends ChatSummary {
  messages: unknown[];
  pending: unknown[];
  notice: string | null;
  files: Record<string, string>;
}

const SUMMARY = `c.id, c.title, c.user_id, u.name AS user_name, (c.hidden_at IS NOT NULL) AS hidden, c.created_at, c.updated_at`;

/** A user's own chats (not the ones they deleted), or with `all` every chat (admins), newest first. */
export function listChats(opts: { userId: number; all: boolean; ofUser?: number | null; q?: string }): Promise<ChatSummary[]> {
  const where: string[] = [];
  const params: Record<string, Bindable> = {};
  if (opts.all) {
    if (opts.ofUser) {
      where.push('c.user_id = @ofUser');
      params.ofUser = opts.ofUser;
    }
  } else {
    where.push('c.user_id = @userId', 'c.hidden_at IS NULL');
    params.userId = opts.userId;
  }
  if (opts.q?.trim()) {
    where.push(`c.title ILIKE @q`);
    params.q = `%${opts.q.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  }
  return query<ChatSummary>(
    `SELECT ${SUMMARY} FROM assistant_chats c LEFT JOIN users u ON u.id = c.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`,
    params,
  );
}

export async function getChat(id: number): Promise<ChatRow | undefined> {
  const row = await one<ChatSummary & { messages: string; pending: string; notice: string | null; files: string }>(
    `SELECT ${SUMMARY}, c.messages, c.pending, c.notice, c.files FROM assistant_chats c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    [id],
  );
  if (!row) return undefined;
  return { ...row, messages: JSON.parse(row.messages), pending: JSON.parse(row.pending), files: JSON.parse(row.files) };
}

export interface ChatState {
  messages: unknown[];
  pending: unknown[];
  notice: string | null;
  files: Record<string, string>;
}

const json = (state: ChatState) => ({
  messages: JSON.stringify(state.messages),
  pending: JSON.stringify(state.pending),
  notice: state.notice,
  files: JSON.stringify(state.files),
});

export function createChat(userId: number, title: string, state: ChatState): Promise<number> {
  return insert(
    `INSERT INTO assistant_chats (user_id, title, messages, pending, notice, files)
     VALUES (@user_id, @title, @messages, @pending, @notice, @files)`,
    { user_id: userId, title, ...json(state) },
  );
}

export async function saveChat(id: number, state: ChatState): Promise<void> {
  await run(
    `UPDATE assistant_chats SET messages = @messages, pending = @pending, notice = @notice, files = @files, updated_at = now() WHERE id = @id`,
    { id, ...json(state) },
  );
}

export async function renameChat(id: number, title: string): Promise<void> {
  await run('UPDATE assistant_chats SET title = ?, updated_at = updated_at WHERE id = ?', [title, id]);
}

/** Hides the chat from its owner; admins still see it. */
export async function hideChat(id: number): Promise<void> {
  await run('UPDATE assistant_chats SET hidden_at = now() WHERE id = ? AND hidden_at IS NULL', [id]);
}

/** A chat's title from its first question: the first line, up to 60 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return (line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line) || 'New chat';
}
