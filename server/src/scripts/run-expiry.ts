/** Runs the daily checks (document expiry and birthdays) once, e.g. `npm run job:expiry`. */
import { disconnect } from '../db/index.js';
import { runExpiryAlerts } from '../jobs/expiryAlerts.js';
import { runBirthdayReminders } from '../jobs/birthdays.js';

console.log((await runExpiryAlerts()).message);
console.log((await runBirthdayReminders()).message);
await disconnect();
