import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { readSecret, writeSecret } from './secrets.js';

/**
 * Outgoing email. The SMTP settings an admin saves under Settings > Email are
 * used first (stored encrypted, password included); otherwise the SMTP_*
 * values from the server environment. Without either (local development,
 * tests) messages are rendered but not sent, and a one-line summary is logged.
 */

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

const SECRET_NAME = 'smtp';

async function savedSmtp(): Promise<SmtpSettings | null> {
  const raw = await readSecret(SECRET_NAME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SmtpSettings;
  } catch {
    return null;
  }
}

function envSmtp(): SmtpSettings | null {
  if (!config.smtp.host) return null;
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user,
    password: config.smtp.pass,
    from: config.smtp.from,
  };
}

async function activeSmtp(): Promise<{ settings: SmtpSettings; source: 'settings' | 'environment' } | null> {
  const saved = await savedSmtp();
  if (saved) return { settings: saved, source: 'settings' };
  const env = envSmtp();
  return env ? { settings: env, source: 'environment' } : null;
}

function createTransport(s: SmtpSettings): Transporter {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

// Reused between emails; rebuilt when the settings change.
let cached: { signature: string; transporter: Transporter } | null = null;
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });

export interface MailStatus {
  configured: boolean;
  source: 'settings' | 'environment' | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  /** Whether a password is stored. The password itself is never returned. */
  passwordSet: boolean;
}

export async function mailStatus(): Promise<MailStatus> {
  const active = await activeSmtp();
  const s = active?.settings;
  return {
    configured: Boolean(active),
    source: active?.source ?? null,
    host: s?.host ?? null,
    port: s?.port ?? null,
    secure: s?.secure ?? false,
    user: s?.user || null,
    from: s?.from || null,
    passwordSet: Boolean(s?.password),
  };
}

/** Saved settings including the password, for keeping it when an admin edits other fields. */
export const savedSmtpSettings = savedSmtp;

/** Connects and logs in to check the settings; throws an Error with a readable message. */
export async function verifySmtp(s: SmtpSettings): Promise<void> {
  const transporter = createTransport(s);
  try {
    await transporter.verify();
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string };
    if (e.code === 'EAUTH' || e.responseCode === 535) {
      throw new Error('The mail server rejected the username or password. For Gmail use an App Password; for Office 365 check that SMTP sign-in (SMTP AUTH) is enabled for this mailbox.');
    }
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET' || e.code === 'ECONNREFUSED') {
      throw new Error(`Could not connect to ${s.host}:${s.port}. Check the server name, the port and the security setting (port 465 uses SSL; 587 uses STARTTLS).`);
    }
    if (e.code === 'EDNS' || e.code === 'ENOTFOUND') throw new Error(`The mail server ${s.host} was not found. Check the server name.`);
    throw new Error(`The mail server did not accept the connection: ${String(e.message ?? err).slice(0, 200)}`);
  } finally {
    transporter.close();
  }
}

export async function saveSmtp(s: SmtpSettings): Promise<void> {
  await writeSecret(SECRET_NAME, JSON.stringify(s));
  cached = null;
}

export async function removeSmtp(): Promise<void> {
  await writeSecret(SECRET_NAME, null);
  cached = null;
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const active = await activeSmtp();
  if (!active) {
    await jsonTransport.sendMail({ from: config.smtp.from, ...message, to: message.to.join(', ') });
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[mail] SMTP not configured, not sent: "${message.subject}" to ${message.to.join(', ')}`);
    }
    return;
  }
  const s = active.settings;
  const signature = JSON.stringify(s);
  if (cached?.signature !== signature) {
    cached?.transporter.close();
    cached = { signature, transporter: createTransport(s) };
  }
  await cached.transporter.sendMail({ from: s.from || config.smtp.from, ...message, to: message.to.join(', ') });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
