import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createUser, getUserByEmail } from '../src/db/repo.js';
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
      .field('expiry_date', addDays(todayInTz(config.timezone), 29))
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
      .field('expiry_date', addDays(todayInTz(config.timezone), 5));
    expect(renewed.status).toBe(200);
    expect(await runExpiryAlerts()).toMatchObject({ sent: true, due: 1 });
  });

  it('sends a birthday reminder once and shows it on the dashboard', async () => {
    const staff = await signIn('staff@test.com');
    const inThreeDays = addDays(todayInTz(config.timezone), 3);
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
  const day = (n: number) => addDays(todayInTz(config.timezone), n);
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
        { type: 'hotel', origin: 'Hotel Adlon', destination: 'Berlin', departure_date: day(33), arrival_date: day(36), confirmation_number: 'H-778' },
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
    expect((await staff.get('/api/trips').query({ filter: 'open_tickets' })).body.trips.map((t: { id: number }) => t.id)).toEqual([tripId]);

    const resolved = await staff
      .post(`/api/trips/${tripId}/tickets/${ticket.body.ticket.id}/resolve`)
      .send({ resolution: 'refunded', notes: 'Refunded to card' });
    expect(resolved.body.ticket.status).toBe('refunded');
    expect((await staff.get('/api/trips').query({ filter: 'open_tickets' })).body.total).toBe(0);
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
    });
    expect(created.status).toBe(201);
    const id = created.body.company.id;

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
    expect((await staff.get(`/api/companies/${id}`)).body.contacts).toEqual({ phones: [], addresses: [] });
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
    expect(sheets.Itinerary.map((i) => i['GDS PNR'])).toContain('ABC123');
  });

  it('exports filtered travellers and companies with their extra phones', async () => {
    const staff = await signIn('staff@test.com');
    const travellers = await download(staff, '/api/travellers/export', { q: 'zara malik' });
    expect(travellers.Travellers).toEqual([expect.objectContaining({ 'First name': 'Zara', 'Extra phones': 'Home: 051-9876543' })]);
    const companies = await download(staff, '/api/companies/export', { q: 'ABC Corporation' });
    expect(companies.Companies.map((c) => c['Company name'])).toEqual(['ABC Corporation']);
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
    expect(ok.body.client).toMatchObject({ state: 'Punjab', country: 'Pakistan' });
    const profile = (await staff.get(`/api/travellers/${ok.body.client.id}`)).body;
    expect(profile.contacts.addresses[0]).toMatchObject({ state: 'Dubai', country: 'United Arab Emirates' });
    // State is searchable.
    expect((await staff.get('/api/travellers').query({ q: 'punjab iqbal' })).body.total).toBe(1);
  });

  it('saves a company state and accepts every country on the list', async () => {
    const staff = await signIn('staff@test.com');
    const res = await staff.post('/api/companies').send({ name: 'Ivory Travel', state: 'Abidjan', country: "Côte d'Ivoire" });
    expect(res.status).toBe(201);
    expect(res.body.company).toMatchObject({ state: 'Abidjan', country: "Côte d'Ivoire" });
    expect((await staff.get('/api/companies').query({ q: 'abidjan' })).body.total).toBe(1);
    // An extra address may be just a state.
    const stateOnly = await staff.post('/api/companies').send({ name: 'State Only Ltd', addresses: [{ label: 'Region', state: 'Sindh' }] });
    expect(stateOnly.status).toBe(201);
  });
});
