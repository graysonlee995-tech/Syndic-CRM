import nodemailer from 'nodemailer';
import { config } from '../config.js';

export const mailConfigured = Boolean(config.smtp.host);

// Without SMTP settings (local development, tests) messages are rendered but
// not sent, and a one-line summary is logged instead.
const transporter = mailConfigured
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(message: MailMessage): Promise<void> {
  await transporter.sendMail({ from: config.smtp.from, ...message, to: message.to.join(', ') });
  if (!mailConfigured && process.env.NODE_ENV !== 'test') {
    console.log(`[mail] SMTP not configured, not sent: "${message.subject}" to ${message.to.join(', ')}`);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
