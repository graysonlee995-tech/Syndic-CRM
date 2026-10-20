import { gunzipSync, gzipSync } from 'node:zlib';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { audit, getSettings, listAudit, saveSettings } from '../db/repo.js';
import { currentUser, SESSION_COOKIE, sessionCookieOptions } from '../auth/session.js';
import { backupProblem, exportDatabase, importDatabase, type Backup } from '../db/backup.js';
import { mailStatus, removeSmtp, saveSmtp, savedSmtpSettings, sendMail, verifySmtp } from '../lib/mailer.js';
import { runExpiryAlerts } from '../jobs/expiryAlerts.js';
import { runBirthdayReminders } from '../jobs/birthdays.js';
import { scheduleAlerts } from '../jobs/scheduler.js';
import { pagingSchema } from './schemas.js';
import { keyStatus, removeAssistantKey, saveAssistantKey } from '../assistant/key.js';
import { contentDisposition, HttpError } from '../lib/http.js';

/** Settings and audit log. Mounted behind requireRole('admin'). */
export const adminRouter = Router();

adminRouter.get('/settings', async (_req, res) => {
  res.json({ settings: await getSettings(), mailConfigured: (await mailStatus()).configured, timezone: config.timezone });
});

adminRouter.put('/settings', async (req, res) => {
  const settings = z
    .object({
      alertThresholds: z
        .array(z.number().int().min(0).max(730))
        .max(10)
        .transform((a) => [...new Set(a)].sort((x, y) => y - x)),
      alertTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24-hour)'),
      birthdayReminders: z.boolean(),
      birthdayDaysAhead: z.number().int().min(0).max(60),
    })
    .parse(req.body);
  await saveSettings(settings);
  await scheduleAlerts();
  await audit(currentUser(req), 'settings_updated', 'settings', null, JSON.stringify(settings));
  res.json({ settings });
});

adminRouter.post('/settings/test-email', async (req, res) => {
  const user = currentUser(req);
  const { configured } = await mailStatus();
  try {
    await sendMail({
    to: [user.email],
    subject: 'Syndic CRM test email',
    text: 'This is a test email from Syndic CRM. Expiry alerts will be delivered the same way.',
    html: '<p>This is a test email from Syndic CRM. Expiry alerts will be delivered the same way.</p>',
    });
  } catch (err) {
    throw new HttpError(502, `The email could not be sent: ${String((err as Error).message).slice(0, 200)}`);
  }
  res.json({
    message: configured
      ? `Test email sent to ${user.email}`
      : 'Email is not set up yet, so nothing was sent. Fill in Settings > Email first.',
  });
});

adminRouter.post('/settings/run-alerts', async (req, res) => {
  const expiry = await runExpiryAlerts();
  const birthdays = await runBirthdayReminders();
  const message = `${expiry.message}. ${birthdays.message}.`;
  await audit(currentUser(req), 'alerts_run_manually', 'settings', null, message);
  res.json({ expiry, birthdays, message });
});

adminRouter.get('/audit', async (req, res) => {
  const { page, pageSize } = pagingSchema.parse(req.query);
  const { rows, total } = await listAudit(pageSize, (page - 1) * pageSize);
  res.json({ entries: rows, total, page, pageSize });
});

// ---------------------------------------------------------------- AI assistant key
// The key itself is never sent back; only whether one is set, where from, and its last 4 characters.

adminRouter.get('/assistant-key', async (_req, res) => {
  res.json({ ...(await keyStatus()), model: config.assistant.model });
});

adminRouter.put('/assistant-key', async (req, res) => {
  const { apiKey } = z.object({ apiKey: z.string().trim().min(1, 'Paste the API key').max(500) }).parse(req.body);
  try {
    await saveAssistantKey(apiKey, config.assistant.model);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  await audit(currentUser(req), 'assistant_key_saved', 'settings', null, `key ending ${apiKey.slice(-4)}`);
  res.json({ ...(await keyStatus()), model: config.assistant.model });
});

adminRouter.delete('/assistant-key', async (req, res) => {
  await removeAssistantKey();
  await audit(currentUser(req), 'assistant_key_removed', 'settings', null);
  res.json({ ...(await keyStatus()), model: config.assistant.model });
});

// ---------------------------------------------------------------- email (SMTP)
// The password is never sent back; leave it empty when saving to keep the stored one.

const smtpSchema = z.object({
  host: z.string().trim().min(1, 'is required').max(200),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(200).default(''),
  password: z.string().max(500).optional().default(''),
  from: z.string().trim().min(1, 'is required').max(300),
});

adminRouter.get('/email', async (_req, res) => {
  res.json(await mailStatus());
});

adminRouter.put('/email', async (req, res) => {
  const input = smtpSchema.parse(req.body);
  // An empty password keeps the saved one (the form never receives it).
  const previous = await savedSmtpSettings();
  const password = input.password || (previous && previous.user === input.user ? previous.password : '');
  if (input.user && !password) throw new HttpError(400, 'password: enter the mailbox password');
  const settings = { ...input, password };
  try {
    await verifySmtp(settings);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  await saveSmtp(settings);
  await audit(currentUser(req), 'email_settings_saved', 'settings', null, `${input.host}:${input.port} as ${input.user || 'no login'}`);
  res.json(await mailStatus());
});

adminRouter.delete('/email', async (req, res) => {
  await removeSmtp();
  await audit(currentUser(req), 'email_settings_removed', 'settings', null);
  res.json(await mailStatus());
});

// ---------------------------------------------------------------- database backup and import

adminRouter.get('/backup', async (req, res) => {
  const backup = await exportDatabase();
  const body = gzipSync(JSON.stringify(backup));
  await audit(currentUser(req), 'database_backup_downloaded', 'settings', null, `${(body.length / 1024).toFixed(0)} KB`);
  res.set({
    'Content-Type': 'application/gzip',
    'Content-Disposition': contentDisposition('attachment', `syndic-crm-backup-${backup.created_at.slice(0, 10)}.json.gz`),
    'Cache-Control': 'private, no-store',
  });
  res.send(body);
});

const backupUpload = multer({
  storage: multer.memoryStorage(),
  // Vercel accepts requests up to 4.5 MB; a compressed backup of a typical agency is far smaller.
  limits: { fileSize: (config.onVercel ? 4 : 200) * 1024 * 1024, files: 1 },
});

/** Replaces ALL data with the uploaded backup. Everyone, including the admin doing it, is signed out. */
adminRouter.post('/restore', backupUpload.single('file'), async (req, res) => {
  const { confirm } = z.object({ confirm: z.string().optional() }).parse(req.body);
  if (confirm !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm that all current data will be replaced.');
  if (!req.file) throw new HttpError(400, 'Choose the backup file to import.');
  let data: unknown;
  try {
    const raw = req.file.buffer[0] === 0x1f && req.file.buffer[1] === 0x8b ? gunzipSync(req.file.buffer) : req.file.buffer;
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'This file could not be read. Choose a backup downloaded from Settings (.json.gz or .json).');
  }
  const problem = backupProblem(data);
  if (problem) throw new HttpError(400, problem);

  const user = currentUser(req);
  const counts = await importDatabase(data as Backup);
  // The importing account may not exist in the backup, so the entry is not tied to a user id.
  await audit(null, 'database_restored', 'settings', null, `by ${user.name} <${user.email}> from a backup made ${(data as Backup).created_at}`);
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  res.json({ ok: true, counts });
});
