import { config } from '../config.js';
import {
  alertRecipients,
  documentsExpiringBy,
  getSettings,
  recordAlerts,
  sentAlertKeys,
  type ExpiringDocument,
} from '../db/repo.js';
import { addDays, daysBetween, todayInTz } from '../lib/dates.js';
import { escapeHtml, sendMail } from '../lib/mailer.js';

export const DOCUMENT_LABELS: Record<string, string> = {
  passport: 'Passport',
  driving_licence: 'Driving licence',
  national_id: 'National ID card',
  visa: 'Visa',
  residence_permit: 'Residence permit',
  other: 'Other document',
};

/**
 * The most urgent threshold a document has reached, or null if it hasn't
 * reached any. With thresholds [90, 30, 7, 0] a document 20 days from expiry
 * has reached 30; one that expired yesterday has reached 0.
 */
export function reachedThreshold(daysLeft: number, thresholds: number[]): number | null {
  const ascending = [...new Set(thresholds)].sort((a, b) => a - b);
  return ascending.find((t) => daysLeft <= t) ?? null;
}

export interface DueAlert<T> {
  doc: T;
  threshold: number;
  daysLeft: number;
}

/** Documents that have reached a threshold for which no alert was sent yet. */
export function computeDueAlerts<T extends { id: number; expiry_date: string }>(
  docs: T[],
  thresholds: number[],
  alreadySent: Set<string>,
  today: string,
): DueAlert<T>[] {
  const due: DueAlert<T>[] = [];
  for (const doc of docs) {
    const daysLeft = daysBetween(today, doc.expiry_date);
    const threshold = reachedThreshold(daysLeft, thresholds);
    if (threshold === null || alreadySent.has(`${doc.id}:${threshold}`)) continue;
    due.push({ doc, threshold, daysLeft });
  }
  return due.sort((a, b) => a.daysLeft - b.daysLeft);
}

export function describeDaysLeft(daysLeft: number): string {
  if (daysLeft < 0) return `EXPIRED ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`;
  if (daysLeft === 0) return 'Expires TODAY';
  return `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
}

function buildDigest(due: DueAlert<ExpiringDocument>[]) {
  const expired = due.filter((d) => d.daysLeft <= 0).length;
  const subject =
    `Document expiry alert: ${due.length} document${due.length === 1 ? '' : 's'} need attention` +
    (expired ? ` (${expired} expired)` : '');

  const lines = due.map(({ doc, daysLeft }) => {
    const name = `${doc.first_name} ${doc.last_name}`;
    return {
      name,
      type: DOCUMENT_LABELS[doc.type] ?? doc.type,
      number: doc.document_number ?? '-',
      expiry: doc.expiry_date,
      status: describeDaysLeft(daysLeft),
      urgent: daysLeft <= 7,
      link: `${config.appUrl}/clients/${doc.client_id}`,
    };
  });

  const text = [
    'The following client documents are expiring soon or have expired:',
    '',
    ...lines.map((l) => `- ${l.name}: ${l.type} ${l.number}, expiry ${l.expiry} (${l.status})\n  ${l.link}`),
    '',
    'You receive this email because you are set up as an alert recipient in the Travel CRM.',
  ].join('\n');

  const cell = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;';
  const rows = lines
    .map(
      (l) => `<tr>
        <td style="${cell}"><a href="${escapeHtml(l.link)}">${escapeHtml(l.name)}</a></td>
        <td style="${cell}">${escapeHtml(l.type)}</td>
        <td style="${cell}">${escapeHtml(l.number)}</td>
        <td style="${cell}">${escapeHtml(l.expiry)}</td>
        <td style="${cell}${l.urgent ? 'color:#b91c1c;font-weight:bold;' : ''}">${escapeHtml(l.status)}</td>
      </tr>`,
    )
    .join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827">
    <p>The following client documents are expiring soon or have expired:</p>
    <table style="border-collapse:collapse">
      <thead><tr>
        <th style="${cell}">Client</th><th style="${cell}">Document</th><th style="${cell}">Number</th>
        <th style="${cell}">Expiry date</th><th style="${cell}">Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#6b7280;font-size:12px">You receive this email because you are set up as an alert recipient in the Travel CRM.</p>
  </div>`;

  return { subject, text, html };
}

export interface AlertRunResult {
  due: number;
  recipients: number;
  sent: boolean;
  message: string;
}

export async function runExpiryAlerts(now = new Date()): Promise<AlertRunResult> {
  const { alertThresholds } = await getSettings();
  if (!alertThresholds.length) {
    return { due: 0, recipients: 0, sent: false, message: 'No alert thresholds configured' };
  }
  const today = todayInTz(config.timezone, now);
  const docs = await documentsExpiringBy(addDays(today, Math.max(...alertThresholds)));
  const due = computeDueAlerts(docs, alertThresholds, await sentAlertKeys(), today);
  if (!due.length) return { due: 0, recipients: 0, sent: false, message: 'No new alerts to send' };

  const recipients = await alertRecipients();
  if (!recipients.length) {
    // Leave them unrecorded so they go out once somebody is set up to receive alerts.
    return {
      due: due.length,
      recipients: 0,
      sent: false,
      message: 'No employees are set to receive alerts. Turn on "Receives alerts" for at least one employee.',
    };
  }

  await sendMail({ to: recipients, ...buildDigest(due) });
  await recordAlerts(due.map((d) => ({ documentId: d.doc.id, threshold: d.threshold })));
  return {
    due: due.length,
    recipients: recipients.length,
    sent: true,
    message: `Sent alert for ${due.length} document(s) to ${recipients.length} employee(s)`,
  };
}
