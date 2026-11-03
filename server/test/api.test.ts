import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createUser, getUserByEmail, timezone } from '../src/db/repo.js';
import { runExpiryAlerts } from '../src/jobs/expiryAlerts.js';
import { runBirthdayReminders } from '../src/jobs/birthdays.js';
import { addDays, todayInTz } from '../src/lib/dates.js';

const app = createApp();
const PASSWORD = 'correct-horse-battery';
const PDF = Buffer.from('%PDF-1.4\n% fake passport scan\n');

async function signIn(email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  const hash = bcrypt.hashSync(PASSWORD, 4);
  await createUser({ name: 'Admin', email: 'admin@test.com', passwordHash: hash, role: 'admin', receivesAlerts: true });
  await createUser({ name: 'Staff', email: 'staff@test.com', passwordHash: hash, role: 'staff' });
  await createUser({ name: 'Locky', email: 'locky@test.com', passwordHash: hash, role: 'staff' });
});

describe('authentication', () => {
  it('rejects requests without a session', async () => {
    expect((await request(app).get('/api/clients')).status).toBe(401);
    expect((await request(app).get('/api/documents/1/file')).status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'staff@test.com', password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('locks the account after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ email: 'locky@test.com', password: 'wrong' });
    }
    const res = await request(app).post('/api/auth/login').send({ email: 'locky@test.com', password: PASSWORD });
    expect(res.status).toBe(423);
  });

  it('logs out', async () => {
    const agent = await signIn('staff@test.com');
    expect((await agent.get('/api/auth/me')).body.user.email).toBe('staff@test.com');
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('blocks cross-site writes', async () => {
    const agent = await signIn('staff@test.com');
    const res = await agent
      .post('/api/clients')
      .set('Origin', 'https://evil.example')
      .send({ first_name: 'A', last_name: 'B' });
    expect(res.status).toBe(403);
  });
});

describe('daily cron endpoint', () => {
  it('only runs with the cron secret', async () => {
    expect((await request(app).get('/api/cron/daily')).status).toBe(401);
    expect((await request(app).get('/api/cron/daily').set('Authorization', 'Bearer wrong')).status).toBe(401);
    const ok = await request(app).get('/api/cron/daily').set('Authorization', 'Bearer test-cron-secret');
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('expiry');
  });

  it('tells signed-in users the upload limit', async () => {
    const staff = await signIn('staff@test.com');
    expect((await staff.get('/api/config')).body).toMatchObject({ maxUploadMb: 15, scheduledAlerts: true });
    expect((await request(app).get('/api/config')).status).toBe(401);
  });
});
describe('roles', () => {
  it('keeps staff out of admin areas', async () => {
    const staff = await signIn('staff@test.com');
    expect((await staff.get('/api/users')).status).toBe(403);
    expect((await staff.get('/api/admin/settings')).status).toBe(403);
    expect((await staff.get('/api/admin/audit')).status).toBe(403);
    const created = await staff.post('/api/clients').send({ first_name: 'Keep', last_name: 'Me' });
    expect(created.status).toBe(201);
    expect((await staff.delete(`/api/clients/${created.body.client.id}`)).status).toBe(403);
  });

  it('never removes the last active admin', async () => {
    const admin = await signIn('admin@test.com');
    const me = (await getUserByEmail('admin@test.com'))!;
    expect((await admin.put(`/api/users/${me.id}`).send({ role: 'staff' })).status).toBe(400);
    expect((await admin.put(`/api/users/${me.id}`).send({ is_active: false })).status).toBe(400);
  });

  it('lets an admin unlock and deactivate staff', async () => {
    const admin = await signIn('admin@test.com');
    const locky = (await getUserByEmail('locky@test.com'))!;
    expect((await admin.put(`/api/users/${locky.id}`).send({ unlock: true })).status).toBe(200);
    await signIn('locky@test.com');
    expect((await admin.put(`/api/users/${locky.id}`).send({ is_active: false })).status).toBe(200);
    const res = await request(app).post('/api/auth/login').send({ email: 'locky@test.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('clients, documents and search', () => {
  let clientId: number;
  let documentId: number;

  beforeAll(async () => {
    const staff = await signIn('staff@test.com');
    const res = await staff.post('/api/clients').send({
      first_name: 'Ayesha',
      last_name: 'Siddiqui',
      date_of_birth: '1985-03-15',
      address_line: '12 Canal View Road',
      city: 'Lahore',
      phone: '+92 300 1234567',
    });
    clientId = res.body.client.id;
  });

  it('rejects files that are not PDF or images', async () => {
    const staff = await signIn('staff@test.com');
    const res = await staff
      .post(`/api/clients/${clientId}/documents`)
      .field('type', 'passport')
      .attach('file', Buffer.from('MZ fake exe'), 'passport.pdf');
    expect(res.status).toBe(400);
  });

  it('stores an uploaded PDF encrypted and serves it back', async () => {
    const staff = await signIn('staff@test.com');
    const res = await staff
      .post(`/api/clients/${clientId}/documents`)
      .field('type', 'passport')
      .field('document_number', 'AB-1234567')
      .field('expiry_date', addDays(todayInTz(timezone()), 29))
      .attach('file', PDF, 'passport.pdf');
    expect(res.status).toBe(201);
    documentId = res.body.document.id;

    const onDisk = fs.readFileSync(path.join(config.dataDir, 'files', res.body.document.file_name));
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);

    const file = await staff.get(`/api/documents/${documentId}/file`).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(file.body)).toEqual(PDF);
  });

  it.each([
    ['passport number', 'AB-1234567'],
    ['passport number without dash', 'ab1234567'],
    ['partial name', 'ayes sidd'],
    ['date of birth', '15/03/1985'],
    ['address', 'canal lahore'],
    ['phone', '300 1234567'],
  ])('finds the client by %s', async (_label, q) => {
    const staff = await signIn('staff@test.com');
    const res = await staff.get('/api/clients').query({ q });
    expect(res.status).toBe(200);
    expect(res.body.clients.map((c: { id: number }) => c.id)).toContain(clientId);
  });

  it('does not match unrelated searches', async () => {
    const staff = await signIn('staff@test.com');
    const res = await staff.get('/api/clients').query({ q: 'zzz-nobody' });
    expect(res.body.total).toBe(0);
  });

  it('shows the document on the dashboard', async () => {
    const staff = await signIn('staff@test.com');
    const res = await staff.get('/api/dashboard');
    expect(res.body.counts.within30).toBeGreaterThanOrEqual(1);
  });

  it('sends one expiry alert and never repeats it', async () => {
    const first = await runExpiryAlerts();
    expect(first).toMatchObject({ sent: true, due: 1, recipients: 1 });
    const second = await runExpiryAlerts();
    expect(second).toMatchObject({ sent: false, due: 0 });
  });

  it('restarts the alert cycle when the document is renewed', async () => {
    const staff = await signIn('staff@test.com');
    const renewed = await staff
      .put(`/api/documents/${documentId}`)
      .field('type', 'passport')
      .field('document_number', 'AB-1234567')
      .field('expiry_date', addDays(todayInTz(timezone()), 5));
    expect(renewed.status).toBe(200);
    expect(await runExpiryAlerts()).toMatchObject({ sent: true, due: 1 });
  });

  it('sends a birthday reminder once and shows it on the dashboard', async () => {
    const staff = await signIn('staff@test.com');
    const inThreeDays = addDays(todayInTz(timezone()), 3);
    const res = await staff
      .post('/api/clients')
      .send({ first_name: 'Birthday', last_name: 'Person', date_of_birth: `1990${inThreeDays.slice(4)}` });
    const id = res.body.client.id;

    const dashboard = await staff.get('/api/dashboard');
    expect(dashboard.body.birthdays).toContainEqual(expect.objectContaining({ id, days_until: 3 }));

    expect(await runBirthdayReminders()).toMatchObject({ sent: true, due: 1 });
    expect(await runBirthdayReminders()).toMatchObject({ sent: false, due: 0 });
  });

  it('moves a deleted client to the trash, restores it, and purges its files', async () => {
    const admin = await signIn('admin@test.com');
    const docs = (await admin.get(`/api/clients/${clientId}`)).body.documents;
    const stored = path.join(config.dataDir, 'files', docs[0].file_name);

    expect((await admin.delete(`/api/clients/${clientId}`)).status).toBe(200);
    expect((await admin.get('/api/clients').query({ q: 'AB1234567' })).body.total).toBe(0);
    expect((await admin.get(`/api/clients/${clientId}`)).status).toBe(404);
    expect(fs.existsSync(stored)).toBe(true);

    expect((await admin.post(`/api/trash/client/${clientId}/restore`)).status).toBe(200);
    expect((await admin.get('/api/travellers').query({ q: 'AB1234567' })).body.total).toBe(1);

    await admin.delete(`/api/clients/${clientId}`);
    expect((await admin.delete(`/api/trash/client/${clientId}`)).status).toBe(200);
    expect(fs.existsSync(stored)).toBe(false);
    expect((await admin.get('/api/trash')).body.items).toHaveLength(0);
  });
});

describe('trips, companies and travellers', () => {
  const day = (n: number) => addDays(todayInTz(timezone()), n);
  let companyId: number;
  let john: number;
  let sarah: number;
  let ahmed: number;
  let tripId: number;

  beforeAll(async () => {
    const staff = await signIn('staff@test.com');
    companyId = (await staff.post('/api/companies').send({ name: 'ABC Corporation', city: 'Karachi' })).body.company.id;
    const add = async (first_name: string, last_name: string) =>
      (await staff.post('/api/travellers').send({ first_name, last_name, company_id: companyId })).body.client.id as number;
    john = await add('John', 'Smith');
    sarah = await add('Sarah', 'Smith');
    ahmed = await add('Ahmed', 'Khan');
    const res = await staff.post('/api/trips').send({
      name: 'Europe Business Tour',
      company_id: companyId,
      traveller_ids: [john, sarah],
      itinerary: [
        // Entered out of time order on purpose: the trip's dates come from the earliest and latest items.
        { type: 'hotel', name: 'Hotel Adlon', destination: 'Berlin', departure_date: day(33), arrival_date: day(36), confirmation_number: 'H-778' },
        { type: 'flight', origin: 'KHI', destination: 'Paris', departure_date: day(30), departure_time: '02:15', arrival_date: day(30), arrival_time: '07:40', gds_pnr: 'abc123' },
        { type: 'flight', origin: 'Berlin', destination: 'KHI', departure_date: day(40), departure_time: '22:00', arrival_date: day(41), arrival_time: '06:30' },
      ],
    });
    expect(res.status).toBe(201);
    tripId = res.body.trip.id;
    expect(res.body.trip.reference).toMatch(/^TRP-\d{4}-\d{5}$/);
    expect(res.body.trip).toMatchObject({ origin: 'KHI', departure_date: day(30), return_date: day(41) });
  });

  it('keeps the itinerary in the order entered and finds trips by PNR or place', async () => {
    const staff = await signIn('staff@test.com');
    const detail = (await staff.get(`/api/trips/${tripId}`)).body;
    expect(detail.itinerary.map((i: { type: string }) => i.type)).toEqual(['hotel', 'flight', 'flight']);
    expect(detail.itinerary[1]).toMatchObject({ departure_time: '02:15', arrival_time: '07:40', gds_pnr: 'ABC123' });
    const list = (await staff.get('/api/trips').query({ q: 'abc123' })).body.trips;
    expect(list).toEqual([expect.objectContaining({ id: tripId, destinations: 'Berlin, Paris, KHI' })]);
  });

  it('rejects a trip without itinerary or with an arrival before departure', async () => {
    const staff = await signIn('staff@test.com');
    const base = { name: 'Bad trip', traveller_ids: [] };
    expect((await staff.post('/api/trips').send({ ...base, itinerary: [] })).status).toBe(400);
    const backwards = await staff.post('/api/trips').send({
      ...base,
      itinerary: [{ type: 'flight', departure_date: day(5), departure_time: '10:00', arrival_date: day(4) }],
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error).toBe('itinerary row 1 arrival date: must be after the departure');
  });

  it('shows the same trip in the trips list, the company and both travellers', async () => {
    const staff = await signIn('staff@test.com');
    const ids = async (query: Record<string, string | number>) =>
      (await staff.get('/api/trips').query(query)).body.trips.map((t: { id: number }) => t.id);
    expect(await ids({})).toContain(tripId);
    expect(await ids({ companyId })).toEqual([tripId]);
    expect(await ids({ travellerId: john })).toEqual([tripId]);
    expect(await ids({ travellerId: sarah })).toEqual([tripId]);
    expect(await ids({ travellerId: ahmed })).toEqual([]);
    expect(await ids({ filter: 'upcoming', q: 'berlin smith' })).toEqual([tripId]);
  });

  it('updates the one record from any entry point', async () => {
    const staff = await signIn('staff@test.com');
    const detail = (await staff.get(`/api/trips/${tripId}`)).body;
    const res = await staff.put(`/api/trips/${tripId}`).send({
      ...detail.trip,
      name: 'Europe Business Tour 2',
      traveller_ids: [john, sarah, ahmed],
      itinerary: detail.itinerary,
    });
    expect(res.status).toBe(200);
    const fromAhmed = (await staff.get('/api/trips').query({ travellerId: ahmed })).body.trips;
    expect(fromAhmed).toEqual([expect.objectContaining({ id: tripId, name: 'Europe Business Tour 2' })]);
    const company = (await staff.get('/api/companies').query({ q: 'ABC' })).body.companies[0];
    expect(company).toMatchObject({ traveller_count: 3, upcoming_trips: 1 });
  });

  it('tracks open flight tickets and their resolution', async () => {
    const staff = await signIn('staff@test.com');
    const flight = await staff
      .post(`/api/trips/${tripId}/flights`)
      .send({ airline: 'PIA', flight_number: 'PK 785', from_airport: 'KHI', to_airport: 'CDG' });
    expect(flight.status).toBe(201);
    const outsider = (await staff.post('/api/travellers').send({ first_name: 'Not', last_name: 'OnTrip' })).body.client.id;
    const rejected = await staff
      .post(`/api/trips/${tripId}/flights/${flight.body.booking.id}/tickets`)
      .send({ client_id: outsider, status: 'open' });
    expect(rejected.status).toBe(400);

    const ticket = await staff
      .post(`/api/trips/${tripId}/flights/${flight.body.booking.id}/tickets`)
      .send({ client_id: john, ticket_number: '214-1234567890', status: 'open' });
    expect(ticket.status).toBe(201);
    const openTickets = async () => (await staff.get('/api/trips').query({ companyId })).body.trips[0].open_tickets;
    expect(await openTickets()).toBe(1);

    const resolved = await staff
      .post(`/api/trips/${tripId}/tickets/${ticket.body.ticket.id}/resolve`)
      .send({ resolution: 'refunded', notes: 'Refunded to card' });
    expect(resolved.body.ticket.status).toBe('refunded');
    expect(await openTickets()).toBe(0);
  });

  it('moves a flight marked as open credit to Open Credits, for the chosen travellers only', async () => {
    const staff = await signIn('staff@test.com');
    const detail = (await staff.get(`/api/trips/${tripId}`)).body;
    const body = (credit: number[]) => ({
      ...detail.trip,
      traveller_ids: detail.travellers.map((t: { id: number }) => t.id),
      itinerary: detail.itinerary.map((i: { type: string }, n: number) =>
        n === 2 ? { ...i, airline: 'Emirates', flight_number: 'ek 601', open_credit: { traveller_ids: credit } } : i,
      ),
    });
    const outsider = (await staff.post('/api/travellers').send({ first_name: 'Not', last_name: 'Travelling' })).body.client.id;
    expect((await staff.put(`/api/trips/${tripId}`).send(body([outsider]))).status).toBe(400);
    expect((await staff.put(`/api/trips/${tripId}`).send(body([john]))).status).toBe(200);

    const after = (await staff.get(`/api/trips/${tripId}`)).body;
    expect(after.itinerary.map((i: { type: string }) => i.type)).toEqual(['hotel', 'flight']);
    expect(after.open_credits).toEqual([
      expect.objectContaining({ client_id: john, airline: 'Emirates', flight_number: 'EK 601', origin: 'Berlin', status: 'open' }),
    ]);
    const list = (await staff.get('/api/open-credits')).body;
    expect(list.credits).toEqual([expect.objectContaining({ company_name: 'ABC CORPORATION', first_name: 'JOHN', trip_id: tripId })]);
    expect((await staff.get('/api/open-credits').query({ travellerId: sarah })).body.total).toBe(0);

    const used = await staff.put(`/api/open-credits/${list.credits[0].id}/status`).send({ status: 'used', notes: 'Rebooked' });
    expect(used.body).toMatchObject({ credit: { status: 'used' } });
    expect((await staff.get('/api/open-credits')).body.total).toBe(0);
    expect((await staff.get('/api/open-credits').query({ status: 'all' })).body.credits[0]).toMatchObject({ status: 'used', notes: 'Rebooked' });

    // Only an admin can put it back on the trip; that removes the credit and restores the row.
    expect((await staff.post(`/api/open-credits/${list.credits[0].id}/move-back`)).status).toBe(403);
    const admin = await signIn('admin@test.com');
    expect((await admin.post(`/api/open-credits/${list.credits[0].id}/move-back`)).body).toMatchObject({ removed: 1 });
    const back = (await staff.get(`/api/trips/${tripId}`)).body;
    expect(back.itinerary.map((i: { type: string }) => i.type)).toEqual(['hotel', 'flight', 'flight']);
    expect(back.itinerary[2]).toMatchObject({ airline: 'Emirates', flight_number: 'EK 601' });
    expect(back.open_credits).toEqual([]);
    expect(back.trip.return_date).toBe(day(41));
  });

  it('turns a hotel into open credit for each chosen traveller, and moves them all back together', async () => {
    const staff = await signIn('staff@test.com');
    const detail = (await staff.get(`/api/trips/${tripId}`)).body;
    const res = await staff.put(`/api/trips/${tripId}`).send({
      ...detail.trip,
      traveller_ids: detail.travellers.map((t: { id: number }) => t.id),
      itinerary: detail.itinerary.map((i: { type: string }) => (i.type === 'hotel' ? { ...i, open_credit: { traveller_ids: [john, sarah] } } : i)),
    });
    expect(res.status).toBe(200);
    const credits = (await staff.get(`/api/trips/${tripId}`)).body.open_credits;
    expect(credits.map((c: { type: string; name: string }) => [c.type, c.name])).toEqual([
      ['hotel', 'Hotel Adlon'],
      ['hotel', 'Hotel Adlon'],
    ]);
    const admin = await signIn('admin@test.com');
    expect((await admin.post(`/api/open-credits/${credits[0].id}/move-back`)).body.removed).toBe(2);
    const after = (await staff.get(`/api/trips/${tripId}`)).body;
    expect(after.open_credits).toEqual([]);
    expect(after.itinerary.filter((i: { type: string }) => i.type === 'hotel')).toEqual([expect.objectContaining({ name: 'Hotel Adlon' })]);
  });

  it('groups trips as recent (-24 h to +48 h, or underway), upcoming and past', async () => {
    const staff = await signIn('staff@test.com');
    const make = async (name: string, departure_date: string, arrival_date?: string) =>
      (await staff.post('/api/trips').send({ name, itinerary: [{ type: 'flight', origin: 'A', destination: 'B', departure_date, arrival_date }] })).body.trip;
    const tomorrow = await make('Phase tomorrow', day(1));
    const underway = await make('Phase underway', day(-5), day(5));
    const later = await make('Phase later', day(4));
    const old = await make('Phase old', day(-10), day(-3));
    expect([tomorrow.phase, underway.phase, later.phase, old.phase]).toEqual(['recent', 'recent', 'upcoming', 'past']);
    const ids = async (filter: string) => (await staff.get('/api/trips').query({ filter, q: 'Phase' })).body.trips.map((t: { id: number }) => t.id);
    expect((await ids('recent')).sort()).toEqual([tomorrow.id, underway.id].sort());
    expect(await ids('upcoming')).toEqual([later.id]);
    expect(await ids('past')).toEqual([old.id]);
    for (const t of [tomorrow, underway, later, old]) await (await signIn('admin@test.com')).delete(`/api/trips/${t.id}`);
  });

  it('has Active, Inactive and Cancelled trip statuses', async () => {
    const staff = await signIn('staff@test.com');
    const detail = (await staff.get(`/api/trips/${tripId}`)).body;
    expect(detail.trip.status).toBe('active');
    const save = (status: string) =>
      staff.put(`/api/trips/${tripId}`).send({ ...detail.trip, status, traveller_ids: detail.travellers.map((t: { id: number }) => t.id), itinerary: detail.itinerary });
    expect((await save('planned')).status).toBe(400);
    expect((await save('inactive')).body.trip).toMatchObject({ status: 'inactive', phase: 'inactive' });
    expect((await staff.get('/api/trips').query({ filter: 'inactive' })).body.total).toBe(1);
    expect((await staff.get('/api/trips').query({ filter: 'upcoming' })).body.total).toBe(0);
    expect((await save('active')).status).toBe(200);
  });

  it('accepts optional cruise passengers and company documents', async () => {
    const staff = await signIn('staff@test.com');
    const empty = await staff.post(`/api/trips/${tripId}/cruises`).send({ cruise_line: 'MSC' });
    expect(empty.status).toBe(201);
    const withPassengers = await staff
      .post(`/api/trips/${tripId}/cruises`)
      .send({ cruise_line: 'Royal Caribbean', traveller_ids: [john, sarah] });
    expect(withPassengers.status).toBe(201);
    const cruises = (await staff.get(`/api/trips/${tripId}`)).body.cruises;
    expect(cruises.map((c: { traveller_ids: number[] }) => c.traveller_ids.length).sort()).toEqual([0, 2]);

    const upload = await staff.post(`/api/companies/${companyId}/documents`).field('title', 'Travel policy').attach('file', PDF, 'policy.pdf');
    expect(upload.status).toBe(201);
    const company = (await staff.get(`/api/companies/${companyId}`)).body;
    expect(company.documents).toEqual([expect.objectContaining({ title: 'Travel policy' })]);
    const file = await staff.get(`/api/companies/${companyId}/documents/${upload.body.document.id}/file`).buffer(true);
    expect(Buffer.from(file.body)).toEqual(PDF);
  });

  it('hides a trashed trip everywhere until it is restored', async () => {
    const staff = await signIn('staff@test.com');
    expect((await staff.delete(`/api/trips/${tripId}`)).status).toBe(403);
    const admin = await signIn('admin@test.com');
    expect((await admin.delete(`/api/trips/${tripId}`)).status).toBe(200);
    expect((await admin.get('/api/trips').query({ travellerId: john })).body.total).toBe(0);
    expect((await admin.get(`/api/trips/${tripId}`)).status).toBe(404);
    await admin.post(`/api/trash/trip/${tripId}/restore`);
    expect((await admin.get('/api/trips').query({ companyId })).body.total).toBe(1);
    const history = (await admin.get('/api/activity').query({ entity: 'trip', id: tripId })).body.entries;
    expect(history.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['trip_created', 'trip_updated', 'trip_ticket_resolved', 'trip_restored']),
    );
  });
});

describe('extra phone numbers and addresses', () => {
  it('saves any number of them for a company, finds the company by them, and keeps them when not sent', async () => {
    const staff = await signIn('staff@test.com');
    const created = await staff.post('/api/companies').send({
      name: 'Multi Office Travels',
      phone: '021-1111111',
      phones: [
        { label: 'WhatsApp', number: '+92 333 7654321' },
        { label: 'Fax', number: '' }, // empty rows are ignored
        { label: 'Office', number: '042-2222222' },
      ],
      addresses: [{ label: 'Branch', address_line: '5 Mall Road', city: 'Lahore', country: 'Pakistan' }],
      emails: [
        { label: 'Accounts', email: 'accounts@multioffice.test' },
        { label: 'Other', email: '' }, // ignored
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.company.id;
    expect((await staff.get(`/api/companies/${id}`)).body.contacts.emails).toEqual([
      expect.objectContaining({ label: 'Accounts', email: 'accounts@multioffice.test' }),
    ]);
    expect((await staff.get('/api/companies').query({ q: 'accounts@multioffice' })).body.total).toBe(1);

    const profile = (await staff.get(`/api/companies/${id}`)).body;
    expect(profile.contacts.phones.map((p: { label: string }) => p.label)).toEqual(['WhatsApp', 'Office']);
    expect(profile.contacts.addresses[0]).toMatchObject({ label: 'Branch', city: 'Lahore' });

    const byPhone = (await staff.get('/api/companies').query({ q: '7654321' })).body.companies;
    expect(byPhone.map((c: { id: number }) => c.id)).toEqual([id]);
    expect((await staff.get('/api/companies').query({ q: 'Mall Road' })).body.total).toBe(1);

    // An update without phones/addresses (e.g. from the assistant) leaves them alone.
    await staff.put(`/api/companies/${id}`).send({ name: 'Multi Office Travels Ltd' });
    expect((await staff.get(`/api/companies/${id}`)).body.contacts.phones).toHaveLength(2);
    // Sending empty lists removes them.
    await staff.put(`/api/companies/${id}`).send({ name: 'Multi Office Travels Ltd', phones: [], addresses: [] });
    expect((await staff.get(`/api/companies/${id}`)).body.contacts).toMatchObject({ phones: [], addresses: [] });
  });

  it('saves them for a traveller and makes them searchable', async () => {
    const staff = await signIn('staff@test.com');
    const created = await staff.post('/api/travellers').send({
      first_name: 'Zara',
      last_name: 'Malik',
      phones: [{ label: 'Home', number: '051-9876543' }],
      addresses: [{ label: 'Home', address_line: 'House 7, F-8', city: 'Islamabad', country: null }],
    });
    expect(created.status).toBe(201);
    const id = created.body.client.id;
    for (const q of ['9876543', '0519876543', 'islamabad']) {
      const found = (await staff.get('/api/travellers').query({ q })).body.clients.map((c: { id: number }) => c.id);
      expect(found).toContain(id);
    }
    expect((await staff.get(`/api/travellers/${id}`)).body.contacts.addresses[0]).toMatchObject({ city: 'Islamabad' });
  });
});

describe('Excel export', () => {
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const stream = res as unknown as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  /** Downloads an export and returns each sheet as rows of { header: value }. */
  async function download(agent: request.Agent, url: string, query: Record<string, string> = {}) {
    const res = await agent.get(url).query(query).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheets: Record<string, Record<string, unknown>[]> = {};
    book.eachSheet((ws) => {
      const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String);
      const rows: Record<string, unknown>[] = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const values = (row.values as unknown[]).slice(1);
        rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i]])));
      });
      sheets[ws.name] = rows;
    });
    return sheets;
  }

  it('exports only the trips matching the filters, with their itinerary', async () => {
    const staff = await signIn('staff@test.com');
    const sheets = await download(staff, '/api/trips/export', { q: 'Europe Business' });
    expect(sheets.Trips.length).toBeGreaterThan(0);
    for (const t of sheets.Trips) expect(String(t['Trip name'])).toContain('Europe Business');
    expect(sheets.Itinerary.map((i) => i['GDS PNR/TKT No.'])).toContain('ABC123');
  });

  it('exports filtered travellers and companies with their extra phones', async () => {
    const staff = await signIn('staff@test.com');
    const travellers = await download(staff, '/api/travellers/export', { q: 'zara malik' });
    expect(travellers.Travellers).toEqual([expect.objectContaining({ 'Given name': 'ZARA', 'Extra phones': 'Home: 051-9876543' })]);
    const companies = await download(staff, '/api/companies/export', { q: 'ABC Corporation' });
    expect(companies.Companies.map((c) => c['Company name'])).toEqual(['ABC CORPORATION']);
  });
});

describe('addresses: state and country list', () => {
  it('only accepts countries from the list, spelled as the list spells them', async () => {
    const staff = await signIn('staff@test.com');
    const bad = await staff.post('/api/travellers').send({ first_name: 'No', last_name: 'Where', country: 'Atlantis' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('not in the country list');
    const badExtra = await staff.post('/api/companies').send({ name: 'Bad Extra Ltd', addresses: [{ city: 'X', country: 'Narnia' }] });
    expect(badExtra.status).toBe(400);

    const ok = await staff.post('/api/travellers').send({
      first_name: 'Sana',
      last_name: 'Iqbal',
      address_line: 'Street 4',
      state: 'Punjab',
      city: 'Lahore',
      country: 'pakistan',
      addresses: [{ label: 'Work', state: 'Dubai', city: 'Dubai', country: 'uae' }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.client).toMatchObject({ state: 'Punjab', country: 'PK - Pakistan' });
    const profile = (await staff.get(`/api/travellers/${ok.body.client.id}`)).body;
    expect(profile.contacts.addresses[0]).toMatchObject({ state: 'Dubai', country: 'AE - United Arab Emirates' });
    // State is searchable.
    expect((await staff.get('/api/travellers').query({ q: 'punjab iqbal' })).body.total).toBe(1);
    // Nationality uses the same IATA list; a code, a name or a nationality word all work.
    for (const [nationality, saved] of [['GB', 'GB - United Kingdom'], ['Pakistani', 'PK - Pakistan'], ['US - United States', 'US - United States']]) {
      const res = await staff.put(`/api/travellers/${ok.body.client.id}`).send({ first_name: 'Sana', last_name: 'Iqbal', nationality });
      expect(res.body.client.nationality).toBe(saved);
    }
  });

  it('saves a company state and accepts every country on the list', async () => {
    const staff = await signIn('staff@test.com');
    const res = await staff.post('/api/companies').send({ name: 'Ivory Travel', state: 'Abidjan', country: "Côte d'Ivoire" });
    expect(res.status).toBe(201);
    expect(res.body.company).toMatchObject({ state: 'Abidjan', country: "CI - Côte d'Ivoire" });
    expect((await staff.get('/api/companies').query({ q: 'abidjan' })).body.total).toBe(1);
    // An extra address may be just a state.
    const stateOnly = await staff.post('/api/companies').send({ name: 'State Only Ltd', addresses: [{ label: 'Region', state: 'Sindh' }] });
    expect(stateOnly.status).toBe(201);
  });
});

describe('CRM time zone', () => {
  it('defaults to US Eastern time and can be changed by an admin', async () => {
    const admin = await signIn('admin@test.com');
    expect((await admin.get('/api/config')).body.timezone).toBe('America/New_York');
    expect((await admin.put('/api/admin/timezone').send({ timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await (await signIn('staff@test.com')).put('/api/admin/timezone').send({ timezone: 'Asia/Karachi' })).status).toBe(403);
    expect((await admin.put('/api/admin/timezone').send({ timezone: 'Asia/Karachi' })).status).toBe(200);
    expect((await admin.get('/api/config')).body.timezone).toBe('Asia/Karachi');
    expect((await admin.get('/api/admin/settings')).body.settings.timezone).toBe('Asia/Karachi');
    await admin.put('/api/admin/timezone').send({ timezone: 'America/New_York' });
  });
});

describe('quality assurance', () => {
  const day = (n: number) => addDays(todayInTz(timezone()), n);

  it('needs every checklist item answered, records who passed it, and resets when the trip changes', async () => {
    const staff = await signIn('staff@test.com');
    const created = await staff.post('/api/trips').send({
      name: 'QC Trip',
      itinerary: [{ type: 'flight', origin: 'JFK', destination: 'LHR', departure_date: day(10) }],
    });
    const tripId = created.body.trip.id;
    const qcOf = async () => (await staff.get(`/api/trips/${tripId}`)).body.qc;

    const before = await qcOf();
    expect(before).toMatchObject({ due: true, status: 'missing' });
    expect(before.items.map((i: { label: string }) => i.label)).toContain('Passport valid');
    expect(before.items).toHaveLength(9);
    const missing = (await staff.get('/api/quality')).body.trips.map((t: { id: number }) => t.id);
    expect(missing).toContain(tripId);
    expect((await staff.get('/api/dashboard')).body.qcMissing.trips.map((t: { id: number }) => t.id)).toContain(tripId);
    expect((await staff.get('/api/trips').query({ q: 'QC Trip' })).body.trips[0].qc_status).toBe('missing');

    // Answering all but one is not enough; any of the three answers counts.
    const answers = before.items.map((i: { id: number }, n: number) => ({ item_id: i.id, answer: ['verified', 'not_available', 'not_required'][n % 3] }));
    expect((await staff.put(`/api/trips/${tripId}/qc`).send({ answers: answers.slice(1) })).body.qc.status).toBe('missing');
    const passed = (await staff.put(`/api/trips/${tripId}/qc`).send({ answers: answers.slice(0, 1) })).body.qc;
    expect(passed).toMatchObject({ status: 'passed', passed_by_name: expect.any(String) });
    expect(passed.items[0]).toMatchObject({ answer: 'verified', answered_by_name: expect.any(String) });
    expect((await staff.get('/api/quality').query({ status: 'passed' })).body.trips.map((t: { id: number }) => t.id)).toContain(tripId);
    expect((await staff.get('/api/quality')).body.trips.map((t: { id: number }) => t.id)).not.toContain(tripId);

    // Booking changes clear it.
    await staff.post(`/api/trips/${tripId}/hotels`).send({ name: 'Savoy' });
    expect(await qcOf()).toMatchObject({ status: 'missing', passed_by_name: null });
    const history = (await staff.get('/api/activity').query({ entity: 'trip', id: tripId })).body.entries.map((e: { action: string }) => e.action);
    expect(history).toEqual(expect.arrayContaining(['trip_qc_passed', 'trip_qc_reset']));
  });

  it('lets an admin add, rename and switch off checklist items', async () => {
    const admin = await signIn('admin@test.com');
    const { items } = (await admin.get('/api/quality/items')).body;
    const next = [
      ...items.map((i: { id: number; label: string }, n: number) => ({ id: i.id, label: n === 0 ? 'Passport valid (6+ months)' : i.label, is_active: n !== 1 })),
      { label: 'Travel insurance', is_active: true },
    ];
    expect((await (await signIn('staff@test.com')).put('/api/admin/qc-items').send({ items: next })).status).toBe(403);
    const saved = (await admin.put('/api/admin/qc-items').send({ items: next })).body.items;
    expect(saved.filter((i: { is_active: boolean }) => i.is_active).map((i: { label: string }) => i.label)).toEqual(
      expect.arrayContaining(['Passport valid (6+ months)', 'Travel insurance']),
    );
    expect(saved.find((i: { label: string }) => i.label === 'Visa requirement').is_active).toBe(false);
  });
});

describe('agency logo', () => {
  // A 1×1 PNG.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  it('lets an admin upload a PNG that anyone can load, and refuses other files', async () => {
    const admin = await signIn('admin@test.com');
    expect((await request(app).get('/api/logo')).status).toBe(404);
    expect((await admin.put('/api/admin/logo').send({ dataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') })).status).toBe(400);
    expect((await (await signIn('staff@test.com')).put('/api/admin/logo').send({ dataUrl: 'data:image/png;base64,' + PNG.toString('base64') })).status).toBe(403);
    const saved = await admin.put('/api/admin/logo').send({ dataUrl: 'data:image/png;base64,' + PNG.toString('base64') });
    expect(saved.status).toBe(200);
    const logo = await request(app).get('/api/logo').buffer(true);
    expect(logo.headers['content-type']).toBe('image/png');
    expect((await admin.get('/api/config')).body.logoVersion).toBe(saved.body.logoVersion);
    expect((await admin.get('/api/admin/settings')).body.settings).not.toHaveProperty('logo');
    await admin.delete('/api/admin/logo');
    expect((await request(app).get('/api/logo')).status).toBe(404);
  });
});

describe('passenger category from date of birth', () => {
  it('is infant under 2, child from 2 to 11, adult from 12, and can be filtered', async () => {
    const staff = await signIn('staff@test.com');
    const today = todayInTz(timezone());
    const yearsAgo = (n: number, days = 0) => addDays(`${Number(today.slice(0, 4)) - n}${today.slice(4)}`, days);
    const people = [
      ['Baby', yearsAgo(2, 1), 'infant'], // turns 2 tomorrow
      ['Twoyear', yearsAgo(2), 'child'], // 2nd birthday today
      ['Eleven', yearsAgo(12, 1), 'child'],
      ['Twelve', yearsAgo(12), 'adult'],
      ['Nodob', null, 'unknown'],
    ] as const;
    const ids: Record<string, number> = {};
    for (const [first_name, date_of_birth] of people) {
      ids[first_name] = (await staff.post('/api/travellers').send({ first_name, last_name: 'Category', date_of_birth })).body.client.id;
    }
    const list = (await staff.get('/api/travellers').query({ q: 'Category', pageSize: 50 })).body.clients;
    for (const [first_name, , category] of people) {
      expect(list.find((c: { id: number }) => c.id === ids[first_name]).category).toBe(category);
    }
    const names = async (category: string) =>
      (await staff.get('/api/travellers').query({ q: 'Category', category })).body.clients.map((c: { first_name: string }) => c.first_name).sort();
    expect(await names('infant')).toEqual(['BABY']);
    expect(await names('child')).toEqual(['ELEVEN', 'TWOYEAR']);
    expect(await names('adult')).toEqual(['TWELVE']);
    expect(await names('unknown')).toEqual(['NODOB']);
  });
});

describe('document types', () => {
  it("has Passport, Residence Card, Visa, Driver's License, KTN and Others with its own name", async () => {
    const staff = await signIn('staff@test.com');
    const id = (await staff.post('/api/travellers').send({ first_name: 'Doc', last_name: 'Types' })).body.client.id;
    const add = (fields: Record<string, string>) => {
      const req = staff.post(`/api/travellers/${id}/documents`);
      for (const [k, v] of Object.entries(fields)) req.field(k, v);
      return req;
    };
    expect((await add({ type: 'ktn', document_number: 'TT12345678' })).status).toBe(201);
    expect((await add({ type: 'national_id', document_number: '1' })).status).toBe(400);
    const noName = await add({ type: 'other', document_number: '2' });
    expect(noName.status).toBe(400);
    expect((await add({ type: 'other', other_type: 'Vaccination certificate', issuing_country: 'pk' })).status).toBe(201);
    const docs = (await staff.get(`/api/travellers/${id}`)).body.documents;
    expect(docs.map((d: { type: string; other_type: string | null; issuing_country: string | null }) => [d.type, d.other_type, d.issuing_country]).sort()).toEqual([
      ['ktn', null, null],
      ['other', 'Vaccination certificate', 'PK - Pakistan'],
    ]);
  });
});

describe('names in capitals', () => {
  it('saves traveller and company names in capitals however they are typed', async () => {
    const staff = await signIn('staff@test.com');
    const company = (await staff.post('/api/companies').send({ name: 'mixed Case travels' })).body.company;
    expect(company.name).toBe('MIXED CASE TRAVELS');
    const client = (await staff.post('/api/travellers').send({ first_name: 'mary-jane', last_name: "o'neil", company_id: company.id })).body.client;
    expect([client.first_name, client.last_name, client.company_name]).toEqual(['MARY-JANE', "O'NEIL", 'MIXED CASE TRAVELS']);
    // Search still ignores case.
    expect((await staff.get('/api/travellers').query({ q: 'mary' })).body.total).toBe(1);
  });
});

describe('staff permissions', () => {
  const create = async (admin: request.Agent, email: string, permissions?: Record<string, string[]>) =>
    (await admin.post('/api/users').send({ name: email, email, role: 'staff', password: PASSWORD, permissions })).body.user;

  it('gives existing staff the same rights as before: view, add, edit and export, but no delete or admin pages', async () => {
    const staff = await signIn('staff@test.com');
    expect((await staff.get('/api/auth/me')).body.user.permissions).toMatchObject({ travellers: ['view', 'add', 'edit', 'export'] });
    const id = (await staff.post('/api/travellers').send({ first_name: 'Perm', last_name: 'Default' })).body.client.id;
    expect((await staff.delete(`/api/travellers/${id}`)).status).toBe(403);
    for (const url of ['/api/trash', '/api/admin/audit', '/api/users', '/api/admin/settings']) expect((await staff.get(url)).status).toBe(403);
  });

  it('enforces what an admin assigns, section by section', async () => {
    const admin = await signIn('admin@test.com');
    const user = await create(admin, 'viewer@test.com', { travellers: ['view'], trash: ['view'], audit: ['view'] });
    expect(user.permissions).toEqual({ travellers: ['view'], trash: ['view'], audit: ['view'] });
    const viewer = await signIn('viewer@test.com');
    expect((await viewer.get('/api/travellers')).status).toBe(200);
    const blocked = await viewer.post('/api/travellers').send({ first_name: 'No', last_name: 'Add' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toContain('permission to add to Travellers');
    expect((await viewer.get('/api/travellers/export')).status).toBe(403);
    expect((await viewer.get('/api/trips')).status).toBe(403);
    expect((await viewer.get('/api/trash')).status).toBe(200);
    expect((await viewer.get('/api/admin/audit')).status).toBe(200);
    // "view" comes with any other right; actions a section doesn't have are dropped.
    const fixed = (await admin.put(`/api/users/${user.id}`).send({ permissions: { companies: ['delete'], dashboard: ['delete'] } })).body.user;
    expect(fixed.permissions).toEqual({ companies: ['view', 'delete'] }); // the Dashboard has no Delete, so nothing is kept for it
    // Backups stay admin-only whatever the permissions.
    await admin.put(`/api/users/${user.id}`).send({ permissions: { settings: ['view', 'edit'] } });
    expect((await viewer.get('/api/admin/backup')).status).toBe(403);
    expect((await viewer.get('/api/admin/settings')).status).toBe(200);
  });

  it('lets staff who manage employees handle staff only, never more than they have', async () => {
    const admin = await signIn('admin@test.com');
    const manager = await create(admin, 'manager@test.com', { employees: ['view', 'edit'], travellers: ['view', 'edit'] });
    const agent = await signIn('manager@test.com');
    expect((await agent.post('/api/users').send({ name: 'X', email: 'x@test.com', role: 'admin', password: PASSWORD })).status).toBe(403);
    expect((await agent.post('/api/users').send({ name: 'Y', email: 'y@test.com', role: 'staff', password: PASSWORD, permissions: { trips: ['view'] } })).status).toBe(403);
    const ok = await agent.post('/api/users').send({ name: 'Z', email: 'z@test.com', role: 'staff', password: PASSWORD, permissions: { travellers: ['view'] } });
    expect(ok.status).toBe(201);
    expect((await agent.put(`/api/users/${manager.id}`).send({ permissions: { travellers: ['view', 'delete'] } })).status).toBe(403);
    const adminRow = (await agent.get('/api/users')).body.users.find((u: { email: string }) => u.email === 'admin@test.com');
    expect((await agent.put(`/api/users/${adminRow.id}`).send({ name: 'Hacked' })).status).toBe(403);
  });
});
