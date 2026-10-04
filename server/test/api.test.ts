import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createUser, getUserByEmail } from '../src/db/repo.js';
import { pool } from '../src/db/index.js';
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

afterAll(async () => {
  await pool.end();
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

  it('signs in with a differently cased email', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'STAFF@test.com', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('protects the daily cron endpoint with the secret', async () => {
    expect((await request(app).post('/api/cron/daily')).status).toBe(401);
    expect((await request(app).post('/api/cron/daily').set('Authorization', 'Bearer wrong')).status).toBe(401);
    config.cronSecret = 'test-secret-123';
    const ok = await request(app).get('/api/cron/daily').set('Authorization', 'Bearer test-secret-123');
    expect(ok.status).toBe(200);
    expect(ok.body.expiry.message).toBeTruthy();
    config.cronSecret = '';
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

  it('treats search wildcards literally', async () => {
    const staff = await signIn('staff@test.com');
    expect((await staff.get('/api/clients').query({ q: '%' })).body.total).toBeGreaterThan(0);
    expect((await staff.get('/api/clients').query({ q: 'ay%' })).body.clients.map((c: { id: number }) => c.id)).toContain(clientId);
    expect((await staff.get('/api/clients').query({ q: '_yesha' })).body.total).toBe(0);
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

  it('lets an admin delete the client and its files', async () => {
    const admin = await signIn('admin@test.com');
    const docs = (await admin.get(`/api/clients/${clientId}`)).body.documents;
    expect((await admin.delete(`/api/clients/${clientId}`)).status).toBe(200);
    expect(fs.existsSync(path.join(config.dataDir, 'files', docs[0].file_name))).toBe(false);
    expect((await admin.get('/api/clients').query({ q: 'AB1234567' })).body.total).toBe(0);
  });
});
