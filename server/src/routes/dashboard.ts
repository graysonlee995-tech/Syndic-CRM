import { Router } from 'express';
import { config } from '../config.js';
import { clientsWithBirthdays, countClients, countDocuments, documentsExpiringBy } from '../db/repo.js';
import { upcomingBirthdays } from '../jobs/birthdays.js';
import { addDays, daysBetween, todayInTz } from '../lib/dates.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (_req, res) => {
  const today = todayInTz(config.timezone);
  const documents = (await documentsExpiringBy(addDays(today, 90))).map((d) => ({
    ...d,
    days_left: daysBetween(today, d.expiry_date),
  }));
  res.json({
    today,
    totals: { clients: await countClients(), documents: await countDocuments() },
    counts: {
      expired: documents.filter((d) => d.days_left < 0).length,
      within7: documents.filter((d) => d.days_left >= 0 && d.days_left <= 7).length,
      within30: documents.filter((d) => d.days_left >= 0 && d.days_left <= 30).length,
      within90: documents.filter((d) => d.days_left >= 0).length,
    },
    documents,
    birthdays: upcomingBirthdays(await clientsWithBirthdays(), 30, today).map((c) => ({
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      phone: c.phone,
      date: c.birthday.date,
      days_until: c.birthday.daysUntil,
      age: c.birthday.age,
    })),
  });
});
