import { config } from '../config.js';
import {
  alertRecipients,
  clientsWithBirthdays,
  getSettings,
  recordBirthdays,
  sentBirthdayKeys,
  type BirthdayClient,
} from '../db/repo.js';
import { nextBirthday, todayInTz, type NextBirthday } from '../lib/dates.js';
import { escapeHtml, sendMail } from '../lib/mailer.js';

export type UpcomingBirthday<T> = T & { birthday: NextBirthday };

/** Clients whose birthday is within `daysAhead` days, soonest first. */
export function upcomingBirthdays<T extends { date_of_birth: string }>(
  clients: T[],
  daysAhead: number,
  today: string,
): UpcomingBirthday<T>[] {
  return clients
    .map((c) => ({ ...c, birthday: nextBirthday(c.date_of_birth, today) }))
    .filter((c) => c.birthday.daysUntil <= daysAhead)
    .sort((a, b) => a.birthday.daysUntil - b.birthday.daysUntil);
}

/** Upcoming birthdays that nobody has been reminded about yet. */
export function computeDueBirthdays<T extends { id: number; date_of_birth: string }>(
  clients: T[],
  daysAhead: number,
  alreadySent: Set<string>,
  today: string,
): UpcomingBirthday<T>[] {
  return upcomingBirthdays(clients, daysAhead, today).filter(
    (c) => !alreadySent.has(`${c.id}:${c.birthday.date.slice(0, 4)}`),
  );
}

export function describeBirthday(daysUntil: number): string {
  if (daysUntil === 0) return 'TODAY';
  if (daysUntil === 1) return 'Tomorrow';
  return `In ${daysUntil} days`;
}

function buildEmail(due: UpcomingBirthday<BirthdayClient>[]) {
  const today = due.filter((c) => c.birthday.daysUntil === 0).length;
  const subject =
    `Client birthdays: ${due.length} coming up` + (today ? ` (${today} today)` : '');
  const lines = due.map((c) => ({
    name: `${c.first_name} ${c.last_name}`,
    when: describeBirthday(c.birthday.daysUntil),
    date: c.birthday.date,
    age: c.birthday.age,
    contact: [c.phone, c.email].filter(Boolean).join(', ') || '-',
    link: `${config.appUrl}/travellers/${c.id}`,
  }));

  const text = [
    'Upcoming client birthdays:',
    '',
    ...lines.map((l) => `- ${l.name}: ${l.when} (${l.date}, turning ${l.age}). Contact: ${l.contact}\n  ${l.link}`),
    '',
    'You receive this email because you are set up as an alert recipient in Syndic CRM.',
  ].join('\n');

  const cell = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;';
  const rows = lines
    .map(
      (l) => `<tr>
        <td style="${cell}"><a href="${escapeHtml(l.link)}">${escapeHtml(l.name)}</a></td>
        <td style="${cell}${l.when === 'TODAY' ? 'font-weight:bold;color:#0f766e;' : ''}">${escapeHtml(l.when)}</td>
        <td style="${cell}">${escapeHtml(l.date)}</td>
        <td style="${cell}">${l.age}</td>
        <td style="${cell}">${escapeHtml(l.contact)}</td>
      </tr>`,
    )
    .join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827">
    <p>Upcoming client birthdays:</p>
    <table style="border-collapse:collapse">
      <thead><tr>
        <th style="${cell}">Client</th><th style="${cell}">When</th><th style="${cell}">Date</th>
        <th style="${cell}">Turns</th><th style="${cell}">Contact</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#6b7280;font-size:12px">You receive this email because you are set up as an alert recipient in Syndic CRM.</p>
  </div>`;
  return { subject, text, html };
}

export interface BirthdayRunResult {
  due: number;
  sent: boolean;
  message: string;
}

export async function runBirthdayReminders(now = new Date()): Promise<BirthdayRunResult> {
  const { birthdayReminders, birthdayDaysAhead } = await getSettings();
  if (!birthdayReminders) return { due: 0, sent: false, message: 'Birthday reminders are turned off' };

  const today = todayInTz(config.timezone, now);
  const due = computeDueBirthdays(await clientsWithBirthdays(), birthdayDaysAhead, await sentBirthdayKeys(), today);
  if (!due.length) return { due: 0, sent: false, message: 'No new birthday reminders' };

  const recipients = await alertRecipients();
  if (!recipients.length) {
    return { due: due.length, sent: false, message: 'No employees are set to receive alerts' };
  }

  await sendMail({ to: recipients, ...buildEmail(due) });
  await recordBirthdays(due.map((c) => ({ clientId: c.id, year: Number(c.birthday.date.slice(0, 4)) })));
  return { due: due.length, sent: true, message: `Sent birthday reminder for ${due.length} client(s)` };
}
