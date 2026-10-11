import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { getSettings, purgeIdleSessions } from '../db/repo.js';
import { timeInTz } from '../lib/dates.js';
import { runExpiryAlerts } from './expiryAlerts.js';
import { runBirthdayReminders } from './birthdays.js';

let alertTask: ScheduledTask | null = null;
let cleanupTask: ScheduledTask | null = null;

function runAlerts(reason: string): void {
  runExpiryAlerts()
    .then((r) => console.log(`[alerts] ${reason}: ${r.message}`))
    .catch((err) => console.error(`[alerts] ${reason} failed:`, err));
  runBirthdayReminders()
    .then((r) => console.log(`[birthdays] ${reason}: ${r.message}`))
    .catch((err) => console.error(`[birthdays] ${reason} failed:`, err));
}

/** (Re)creates the daily alert job from the current settings. */
export async function scheduleAlerts(): Promise<void> {
  const [hour, minute] = (await getSettings()).alertTime.split(':').map(Number);
  alertTask?.stop();
  alertTask = cron.schedule(`${minute} ${hour} * * *`, () => runAlerts('daily run'), {
    timezone: config.timezone,
  });
}

export async function startScheduler(): Promise<void> {
  await scheduleAlerts();
  cleanupTask = cron.schedule('0 3 * * *', () => purgeIdleSessions(config.sessionIdleHours).catch((err) => console.error('[sessions] cleanup failed:', err)), {
    timezone: config.timezone,
  });
  // If the server was down at the scheduled time, catch up now. Alerts are
  // de-duplicated, so this never sends the same alert twice.
  if (timeInTz(config.timezone) >= (await getSettings()).alertTime) runAlerts('catch-up on start');
}

export function stopScheduler(): void {
  alertTask?.stop();
  cleanupTask?.stop();
}
