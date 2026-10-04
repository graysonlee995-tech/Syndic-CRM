import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { audit, getSettings, listAudit, saveSettings } from '../db/repo.js';
import { currentUser } from '../auth/session.js';
import { mailConfigured, sendMail } from '../lib/mailer.js';
import { runExpiryAlerts } from '../jobs/expiryAlerts.js';
import { runBirthdayReminders } from '../jobs/birthdays.js';
import { scheduleAlerts } from '../jobs/scheduler.js';
import { pagingSchema } from './schemas.js';

/** Settings and audit log. Mounted behind requireRole('admin'). */
export const adminRouter = Router();

adminRouter.get('/settings', async (_req, res) => {
  res.json({ settings: await getSettings(), mailConfigured, timezone: config.timezone });
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
  await sendMail({
    to: [user.email],
    subject: 'Travel CRM test email',
    text: 'This is a test email from the Travel CRM. Expiry alerts will be delivered the same way.',
    html: '<p>This is a test email from the Travel CRM. Expiry alerts will be delivered the same way.</p>',
  });
  res.json({
    message: mailConfigured
      ? `Test email sent to ${user.email}`
      : 'SMTP is not configured on the server, so nothing was sent. Set SMTP_* in the .env file.',
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
