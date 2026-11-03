import { Router } from 'express';
import { clientsWithBirthdays, documentsExpiringBy, timezone } from '../db/repo.js';
import { searchQc } from '../db/quality.js';
import { countRecentTrips, countUpcomingTrips } from '../db/trips.js';
import { upcomingBirthdays } from '../jobs/birthdays.js';
import { addDays, daysBetween, todayInTz } from '../lib/dates.js';
import { requirePermission } from '../auth/permissions.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', requirePermission('dashboard', 'view'), async (_req, res) => {
  const today = todayInTz(timezone());
  const documents = (await documentsExpiringBy(addDays(today, 30))).map((d) => ({
    ...d,
    days_left: daysBetween(today, d.expiry_date),
  }));
  res.json({
    today,
    totals: {
      recentTrips: await countRecentTrips(),
      upcomingTrips: await countUpcomingTrips(),
    },
    // Upcoming and ongoing trips whose quality check is not complete, soonest first.
    qcMissing: await searchQc({ q: '', status: 'missing', companyId: null, today, limit: 10, offset: 0 }).then(({ rows, total }) => ({ trips: rows, total })),
    counts: {
      expired: documents.filter((d) => d.days_left < 0).length,
      within7: documents.filter((d) => d.days_left >= 0 && d.days_left <= 7).length,
      within30: documents.filter((d) => d.days_left >= 0 && d.days_left <= 30).length,
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
