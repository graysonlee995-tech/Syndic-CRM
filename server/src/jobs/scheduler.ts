import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { getSettings, purgeIdleSessions } from '../db/repo.js';
import { timeInTz } from '../lib/dates.js';
import { runExpiryAlerts } from './expiryAlerts.js';
import { runBirthdayReminders } from './birthdays.js';

let alertTask: ScheduledTask | null = null;
let cleanupTask: ScheduledTask | null = null;

/** Runs the daily checks. Alerts are de-duplicated, so running it twice never sends anything twice. */
export async function runDailyJobs(reason: string) {
  const expiry = await runExpiryAlerts().catch((err) => {
    console.error(`[alerts] ${reason} failed:`, err);
    return { message: `Expiry alerts failed: ${(err as Error).message}` };
  });
  console.log(`[alerts] ${reason}: ${expiry.message}`);
  const birthdays = await runBirthdayReminders().catch((err) => {
    console.error(`[birthdays] ${reason} failed:`, err);
    return { message: `Birthday reminders failed: ${(err as Error).message}` };
  });
  console.log(`[birthdays] ${reason}: ${birthdays.message}`);
  await purgeIdleSessions(config.sessionIdleHours).catch(() => {});
  return { expiry, birthdays };
}

/** (Re)creates the in-app daily alert job from the current settings. */
export async function scheduleAlerts(): Promise<void> {
  if (!config.inAppScheduler) return;
  alertTask?.stop();
  const [hour, minute] = (await getSettings()).alertTime.split(':').map(Number);
  alertTask = cron.schedule(`${minute} ${hour} * * *`, () => void runDailyJobs('daily run'), {
    timezone: config.timezone,
  });
}

/**
 * Starts the in-app timer (for always-on hosts). On hosts that sleep, set
 * IN_APP_SCHEDULER=false and let Supabase pg_cron call POST /api/cron/daily.
 * Either way, a server that starts after the alert time catches up once.
 */
export async function startScheduler(): Promise<void> {
  if (config.inAppScheduler) {
    await scheduleAlerts();
    cleanupTask = cron.schedule('0 3 * * *', () => void purgeIdleSessions(config.sessionIdleHours), {
      timezone: config.timezone,
    });
  }
  if (timeInTz(config.timezone) >= (await getSettings()).alertTime) await runDailyJobs('catch-up on start');
}

export function stopScheduler(): void {
  alertTask?.stop();
  cleanupTask?.stop();
}
