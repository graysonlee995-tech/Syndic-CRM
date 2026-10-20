import { gunzipSync } from 'node:zlib';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in mail server: records connections and messages, sends nothing.
const mail = vi.hoisted(() => ({ verify: vi.fn(), sendMail: vi.fn(), transports: [] as Record<string, unknown>[] }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      mail.transports.push(options);
      return { verify: mail.verify, sendMail: mail.sendMail, close: () => undefined };
    },
  },
}));

const { createApp } = await import('../src/app.js');
const { createUser } = await import('../src/db/repo.js');

const app = createApp();
const PASSWORD = 'correct-horse-battery';

async function signIn(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

const office365 = {
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  user: 'crm@agency.test',
  password: 'mailbox-secret-123',
  from: 'Syndic CRM <crm@agency.test>',
};

beforeAll(async () => {
  const hash = bcrypt.hashSync(PASSWORD, 4);
  await createUser({ name: 'Boss', email: 'boss@agency.test', passwordHash: hash, role: 'admin' });
  await createUser({ name: 'Agent', email: 'agent@agency.test', passwordHash: hash, role: 'staff' });
});

beforeEach(() => {
  mail.verify.mockReset();
  mail.sendMail.mockReset();
  mail.transports.length = 0;
});

describe('email settings', () => {
  it('rejects login details the mail server does not accept', async () => {
    const admin = await signIn('boss@agency.test');
    expect((await admin.get('/api/admin/email')).body).toMatchObject({ configured: false });
    mail.verify.mockRejectedValueOnce(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    const res = await admin.put('/api/admin/email').send(office365);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('rejected the username or password');
    expect((await admin.get('/api/admin/email')).body).toMatchObject({ configured: false });
  });

  it('saves working settings without ever returning the password, and keeps it when left empty', async () => {
    const admin = await signIn('boss@agency.test');
    mail.verify.mockResolvedValue(true);
    const saved = await admin.put('/api/admin/email').send(office365);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, source: 'settings', host: 'smtp.office365.com', passwordSet: true });
    expect(JSON.stringify(saved.body)).not.toContain('mailbox-secret-123');
    expect(JSON.stringify((await admin.get('/api/admin/settings')).body)).not.toContain('mailbox-secret-123');

    // Changing the sender without retyping the password keeps the stored one.
    await admin.put('/api/admin/email').send({ ...office365, password: '', from: 'Agency <crm@agency.test>' });
    expect(mail.transports.at(-1)).toMatchObject({ auth: { user: 'crm@agency.test', pass: 'mailbox-secret-123' } });
    expect((await admin.get('/api/admin/email')).body).toMatchObject({ from: 'Agency <crm@agency.test>' });
  });

  it('sends the test email through the saved server', async () => {
    const admin = await signIn('boss@agency.test');
    mail.verify.mockResolvedValue(true);
    await admin.put('/api/admin/email').send(office365);
    const res = await admin.post('/api/admin/settings/test-email');
    expect(res.body.message).toBe('Test email sent to boss@agency.test');
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'boss@agency.test', from: office365.from }));
  });

  it('is for administrators only and can be removed', async () => {
    const staff = await signIn('agent@agency.test');
    expect((await staff.get('/api/admin/email')).status).toBe(403);
    expect((await staff.put('/api/admin/email').send(office365)).status).toBe(403);
    const admin = await signIn('boss@agency.test');
    expect((await admin.delete('/api/admin/email')).body).toMatchObject({ configured: false });
  });
});

describe('database backup and import', () => {
  // Collects a binary download into a Buffer.
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const stream = res as unknown as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('is for administrators only', async () => {
    const staff = await signIn('agent@agency.test');
    expect((await staff.get('/api/admin/backup')).status).toBe(403);
    expect((await staff.post('/api/admin/restore').field('confirm', 'RESTORE')).status).toBe(403);
  });

  it('downloads everything except sessions, and importing it brings the earlier data back', async () => {
    const admin = await signIn('boss@agency.test');
    await admin.post('/api/companies').send({ name: 'Before Backup Ltd', phones: [{ label: 'Office', number: '111' }] });

    const download = await admin.get('/api/admin/backup').buffer(true).parse(binary);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('syndic-crm-backup-');
    const file = download.body as Buffer;
    const backup = JSON.parse(gunzipSync(file).toString('utf8'));
    expect(backup.format).toBe('syndic-crm-backup');
    expect(backup.tables.sessions).toBeUndefined();
    expect(backup.tables.companies.map((c: { name: string }) => c.name)).toContain('Before Backup Ltd');

    // Changes after the backup...
    await admin.post('/api/companies').send({ name: 'After Backup Ltd' });

    // ...are gone after importing it, and everyone has to sign in again.
    const noConfirm = await admin.post('/api/admin/restore').attach('file', file, 'backup.json.gz');
    expect(noConfirm.status).toBe(400);
    const restored = await admin.post('/api/admin/restore').field('confirm', 'RESTORE').attach('file', file, 'backup.json.gz');
    expect(restored.status).toBe(200);
    expect(restored.body.counts.companies).toBe(backup.tables.companies.length);
    expect((await admin.get('/api/companies')).status).toBe(401);

    const again = await signIn('boss@agency.test');
    const names = (await again.get('/api/companies')).body.companies.map((c: { name: string }) => c.name);
    expect(names).toContain('Before Backup Ltd');
    expect(names).not.toContain('After Backup Ltd');
    const id = (await again.get('/api/companies').query({ q: 'Before Backup' })).body.companies[0].id;
    expect((await again.get(`/api/companies/${id}`)).body.contacts.phones[0].number).toBe('111');
    // New records continue numbering after the imported ones.
    expect((await again.post('/api/companies').send({ name: 'New After Restore' })).status).toBe(201);
  });

  it('refuses files that are not a backup and changes nothing', async () => {
    const admin = await signIn('boss@agency.test');
    const before = (await admin.get('/api/companies')).body.total;
    const res = await admin.post('/api/admin/restore').field('confirm', 'RESTORE').attach('file', Buffer.from('{"hello":1}'), 'x.json');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not a Syndic CRM backup');
    expect((await admin.get('/api/companies')).body.total).toBe(before);
  });
});
