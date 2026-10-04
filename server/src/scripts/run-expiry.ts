/** Runs the daily checks (document expiry and birthdays) once, e.g. `npm run job:expiry`. */
import { runExpiryAlerts } from '../jobs/expiryAlerts.js';
import { runBirthdayReminders } from '../jobs/birthdays.js';
import { pool } from '../db/index.js';

console.log((await runExpiryAlerts()).message);
console.log((await runBirthdayReminders()).message);
await pool.end();
