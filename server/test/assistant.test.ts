import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted stand-in for Claude: each test queues the responses Claude would give.
const { create, retrieve, upload, constructed } = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'e'.repeat(80) + 'ENVK';
  return { create: vi.fn(), retrieve: vi.fn(), upload: vi.fn(), constructed: [] as { apiKey?: string }[] };
});
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status = 500;
  }
  class Anthropic {
    static APIError = APIError;
    static RateLimitError = class extends APIError {};
    static AuthenticationError = class extends APIError {};
    static BadRequestError = class extends APIError {};
    static PermissionDeniedError = class extends APIError {};
    static NotFoundError = class extends APIError {};
    // The route streams; the stand-in hands back the queued reply as the final message.
    beta = { messages: { create, stream: (params: unknown) => ({ finalMessage: () => create(params) }) } };
    models = { retrieve };
    files = { upload };
    constructor(options: { apiKey?: string } = {}) {
      constructed.push(options);
    }
  }
  const toFile = async (data: Buffer, name: string, options: { type: string }) => ({ data, name, type: options.type });
  return { default: Anthropic, toFile };
});

const { createApp } = await import('../src/app.js');
const { createUser, createClient, listActivity, getSecret } = await import('../src/db/repo.js');
const Anthropic = (await import('@anthropic-ai/sdk')).default;
const { searchTrips } = await import('../src/db/trips.js');

const app = createApp();
const PASSWORD = 'correct-horse-battery';
let travellerId: number;

const reply = (content: unknown[], stop_reason = 'end_turn') => ({ content, stop_reason });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t });
/** The tool_result block for a tool call, from what was sent to Claude. */
const resultFor = (id: string, call = 1) =>
  (create.mock.calls[call][0].messages as { content: unknown }[])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === id);

async function signIn(email = 'agent@test.com') {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

const tripInput = {
  name: 'Lahore Conference',
  itinerary: [{ type: 'flight', origin: 'KHI', destination: 'LHE', departure_date: '2027-01-10', departure_time: '08:00' }],
};

beforeAll(async () => {
  const user = await createUser({ name: 'Agent', email: 'agent@test.com', passwordHash: bcrypt.hashSync(PASSWORD, 4), role: 'staff' });
  await createUser({ name: 'Boss', email: 'boss@test.com', passwordHash: bcrypt.hashSync(PASSWORD, 4), role: 'admin' });
  const empty = { company_ids: [] as number[], date_of_birth: null, gender: null, nationality: null, phone: null, email: null, address_line: null, state: null, city: null, country: null, seat_preference: null, meal_preference: null, cabin_preference: null, special_requirements: null, notes: null, sabre_entry: null };
  travellerId = await createClient({ ...empty, first_name: 'Hina', last_name: 'Raza' }, user);
});

beforeEach(() => {
  create.mockReset();
  retrieve.mockReset();
  upload.mockReset();
});

describe('assistant', () => {
  it('runs look-ups straight away and answers', async () => {
    create
      .mockResolvedValueOnce(reply([toolUse('t1', 'search_travellers', { query: 'hina' })], 'tool_use'))
      .mockResolvedValueOnce(reply([text('Hina Raza has no trips yet.')]));
    const agent = await signIn();
    const res = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Find Hina' }] });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeUndefined();
    // The look-up result went back to Claude in the second call.
    const sent = resultFor('t1');
    expect(sent).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(JSON.parse(sent.content).travellers[0]).toMatchObject({ id: travellerId, name: 'Hina Raza' });
    expect(res.body.messages.at(-1).content[0].text).toBe('Hina Raza has no trips yet.');
    // The model and effort the agency chose.
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
  });

  it('waits for approval before creating a trip, then creates it', async () => {
    create.mockResolvedValueOnce(
      reply([toolUse('w1', 'create_trips', { trips: [{ ...tripInput, traveller_ids: [travellerId] }] })], 'tool_use'),
    );
    const agent = await signIn();
    const first = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Book Hina to Lahore' }] });
    expect(first.body.pending).toEqual([expect.objectContaining({ id: 'w1', name: 'create_trips' })]);
    expect(first.body.pending[0].preview.rows).toEqual([{ cells: ['Lahore Conference', '2027-01-10', '1 item(s)', '1'] }]);
    expect((await searchTrips({ q: 'Lahore Conference', filter: 'all', companyId: null, travellerId: null, sort: null, dir: 'asc', today: '2026-01-01', limit: 5, offset: 0 })).total).toBe(0);

    create.mockResolvedValueOnce(reply([text('Done: the trip is created.')]));
    const second = await agent.post('/api/assistant/chat').send({ messages: first.body.messages, decisions: { w1: true } });
    expect(second.status).toBe(200);
    const trips = await searchTrips({ q: 'Lahore Conference', filter: 'all', companyId: null, travellerId: travellerId, sort: null, dir: 'asc', today: '2026-01-01', limit: 5, offset: 0 });
    expect(trips.total).toBe(1);
    const history = await listActivity('trip', trips.rows[0].id);
    expect(history[0].details).toContain('(via assistant)');
  });

  it('changes nothing when the employee declines', async () => {
    create.mockResolvedValueOnce(reply([toolUse('w2', 'create_companies', { companies: [{ name: 'Declined Ltd' }] })], 'tool_use'));
    const agent = await signIn();
    const first = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Add Declined Ltd' }] });
    create.mockResolvedValueOnce(reply([text('Okay, I did not create it.')]));
    await agent.post('/api/assistant/chat').send({ messages: first.body.messages, decisions: { w2: false } });
    const result = resultFor('w2');
    expect(result).toMatchObject({ tool_use_id: 'w2', is_error: true });
    expect((await agent.get('/api/companies').query({ q: 'Declined' })).body.total).toBe(0);
  });

  it('never sends passport numbers to Claude', async () => {
    const agent = await signIn();
    await agent
      .post(`/api/travellers/${travellerId}/documents`)
      .field('type', 'passport')
      .field('document_number', 'ZX9988776')
      .field('expiry_date', '2030-05-01');
    create
      .mockResolvedValueOnce(reply([toolUse('t3', 'get_traveller', { traveller_id: travellerId })], 'tool_use'))
      .mockResolvedValueOnce(reply([text('Passport valid until 1 May 2030.')]));
    await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Passport status of Hina?' }] });
    const sent = JSON.stringify(create.mock.calls[1][0].messages);
    expect(sent).toContain('2030-05-01');
    expect(sent).not.toContain('ZX9988776');
  });

  it('adds a whole sheet of travellers in one approved action, with a company from the same batch, skipping duplicates', async () => {
    const rows = [
      { first_name: 'ali', last_name: 'khan', date_of_birth: '1990-02-03', nationality: 'Pakistani', company_name: 'Sheet Travels', documents: [{ type: 'passport', document_number: 'AB1', expiry_date: '2031-01-01' }], sabre_entries: ['-KHAN/ALI MR'] },
      { first_name: 'Hina', last_name: 'Raza' }, // already in the CRM
      { first_name: 'No', last_name: 'Company', company_name: 'Nowhere Ltd' },
    ];
    create.mockResolvedValueOnce(
      reply([toolUse('c1', 'create_companies', { companies: [{ name: 'Sheet Travels', city: 'Karachi' }] }), toolUse('c2', 'create_travellers', { travellers: rows })], 'tool_use'),
    );
    const agent = await signIn();
    const first = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Add everyone in the sheet' }] });
    const preview = first.body.pending.find((p: { id: string }) => p.id === 'c2').preview;
    expect(preview.rows.map((r: { cells: string[]; problem?: string }) => [r.cells[0], r.problem ?? 'ok'])).toEqual([
      ['ALI KHAN', 'ok'],
      ['HINA RAZA', expect.stringContaining('looks like existing traveller')],
      ['NO COMPANY', expect.stringContaining('company "Nowhere Ltd" not found')],
    ]);
    expect(preview.rows[0].cells[3]).toBe('SHEET TRAVELS (new)');

    create.mockResolvedValueOnce(reply([text('Added 1 traveller; 2 rows skipped.')]));
    await agent.post('/api/assistant/chat').send({ messages: first.body.messages, decisions: { c1: true, c2: true } });
    const result = JSON.parse(resultFor('c2').content);
    expect(result).toMatchObject({ created: 1, skipped: [expect.objectContaining({ row: 2 }), expect.objectContaining({ row: 3 })] });
    const ali = (await agent.get(`/api/travellers/${result.travellers[0].id}`)).body;
    expect(ali.client).toMatchObject({ first_name: 'ALI', nationality: 'PK - Pakistan', company_name: 'SHEET TRAVELS', sabre_entry: '-KHAN/ALI MR' });
    expect(ali.documents).toEqual([expect.objectContaining({ type: 'passport', expiry_date: '2031-01-01' })]);
  });

  it('edits travellers and only moves records to the Trash with Delete permission', async () => {
    create.mockResolvedValueOnce(
      reply([toolUse('u1', 'update_travellers', { updates: [{ traveller_id: travellerId, phone: '+1 212 555 0123', add_sabre_entries: ['-RAZA/HINA MS'] }] })], 'tool_use'),
    );
    const agent = await signIn();
    const first = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Update Hina' }] });
    expect(first.body.pending[0].preview.rows[0].cells[2]).toBe('phone, sabre entries');
    create.mockResolvedValueOnce(reply([text('Updated.')]));
    await agent.post('/api/assistant/chat').send({ messages: first.body.messages, decisions: { u1: true } });
    expect((await agent.get(`/api/travellers/${travellerId}`)).body.client).toMatchObject({ phone: '+1 212 555 0123', sabre_entry: '-RAZA/HINA MS' });

    const trash = { records: [{ kind: 'traveller', id: travellerId }] };
    create.mockResolvedValueOnce(reply([toolUse('x1', 'move_to_trash', trash)], 'tool_use'));
    const staffTry = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Trash Hina' }] });
    expect(staffTry.body.pending[0].preview.rows[0].problem).toContain("don't have permission");
    create.mockResolvedValueOnce(reply([text('Only an admin can do that.')]));
    await agent.post('/api/assistant/chat').send({ messages: staffTry.body.messages, decisions: { x1: true } });
    expect((await agent.get(`/api/travellers/${travellerId}`)).status).toBe(200);
  });

  it('turns an attached Excel sheet into text for Claude', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet('Passengers');
    ws.addRow(['Given name', 'Last name', 'DOB']);
    ws.addRow(['Sara', 'Ahmed', new Date(Date.UTC(1992, 9, 1))]);
    const xlsx = Buffer.from(await book.xlsx.writeBuffer());
    upload.mockResolvedValueOnce({ id: 'file_123' });
    const agent = await signIn();
    const res = await agent.post('/api/assistant/attachments').attach('file', xlsx, 'passengers.xlsx');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'sheet', name: 'passengers.xlsx', block: { type: 'document', source: { type: 'file', file_id: 'file_123' }, title: 'passengers.xlsx' } });
    const sent = upload.mock.calls[0][0].file;
    expect(sent.type).toBe('text/plain');
    expect(sent.data.toString()).toContain('Given name,Last name,DOB\nSara,Ahmed,1992-10-01');
    expect((await agent.post('/api/assistant/attachments').attach('file', Buffer.from('x'), 'old.xls')).status).toBe(400);
  });

  it('never runs a tool call from a reply that was cut off', async () => {
    create.mockResolvedValueOnce(reply([toolUse('m1', 'create_companies', { companies: [{ name: 'Half' }] })], 'max_tokens'));
    const agent = await signIn();
    const res = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Add a huge sheet' }] });
    expect(res.body.pending).toBeUndefined();
    expect(res.body.notice).toContain('too long');
    expect(res.body.messages.at(-1).role).toBe('user');
  });

  it('requires sign-in', async () => {
    expect((await request(app).post('/api/assistant/chat').send({ messages: [] })).status).toBe(401);
  });
});

describe('chat history', () => {
  it("saves each employee's chats, lets them continue, rename and delete them, and shows admins everyone's", async () => {
    const agent = await signIn();
    create.mockResolvedValueOnce(reply([text('Hello Agent.')]));
    const first = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Which trips leave this week?\nThanks' }] });
    const chatId = first.body.chatId;
    expect(chatId).toEqual(expect.any(Number));

    create.mockResolvedValueOnce(reply([text('None.')]));
    const messages = [...first.body.messages, { role: 'user', content: 'And next week?' }];
    expect((await agent.post('/api/assistant/chat').send({ messages, chatId })).body.chatId).toBe(chatId);

    const mine = (await agent.get('/api/assistant/chats')).body.chats;
    // Newest first; earlier tests in this file saved chats for this employee too.
    expect(mine[0]).toMatchObject({ id: chatId, title: 'Which trips leave this week?', user_name: 'Agent' });
    const opened = (await agent.get(`/api/assistant/chats/${chatId}`)).body;
    expect(opened.readOnly).toBe(false);
    expect(opened.chat.messages).toHaveLength(4);

    // Another employee can neither see nor continue it; an admin can read it, read-only.
    const boss = await signIn('boss@test.com');
    expect((await boss.get('/api/assistant/chats')).body.chats.map((c: { id: number }) => c.id)).not.toContain(chatId);
    const all = (await boss.get('/api/assistant/chats').query({ all: 1 })).body.chats;
    expect(all.find((c: { id: number }) => c.id === chatId)).toMatchObject({ user_name: 'Agent' });
    expect((await boss.get(`/api/assistant/chats/${chatId}`)).body.readOnly).toBe(true);
    expect((await boss.post('/api/assistant/chat').send({ messages, chatId })).status).toBe(403);
    expect((await agent.get('/api/assistant/chats').query({ all: 1 })).body.chats.every((c: { user_name: string }) => c.user_name === 'Agent')).toBe(true);

    await agent.put(`/api/assistant/chats/${chatId}`).send({ title: 'Weekly trips' });
    expect((await agent.get('/api/assistant/chats')).body.chats[0].title).toBe('Weekly trips');
    await agent.delete(`/api/assistant/chats/${chatId}`);
    expect((await agent.get('/api/assistant/chats')).body.chats.map((c: { id: number }) => c.id)).not.toContain(chatId);
    expect((await agent.get(`/api/assistant/chats/${chatId}`)).status).toBe(404);
    const stillThere = (await boss.get('/api/assistant/chats').query({ all: 1 })).body.chats.find((c: { id: number }) => c.id === chatId);
    expect(stillThere).toMatchObject({ hidden: true });
  });
});

describe('assistant API key in Settings', () => {
  const goodKey = 'sk-ant-api03-' + 'a'.repeat(80) + 'WXYZ';

  it('rejects the shortened preview and keys Anthropic does not accept', async () => {
    const admin = await signIn('boss@test.com');
    const preview = await admin.put('/api/admin/assistant-key').send({ apiKey: 'sk-ant-api03-Ab...XyZ' });
    expect(preview.status).toBe(400);
    expect(preview.body.error).toContain('shortened preview');
    expect(retrieve).not.toHaveBeenCalled();

    retrieve.mockRejectedValueOnce(Object.create(Anthropic.AuthenticationError.prototype));
    const rejected = await admin.put('/api/admin/assistant-key').send({ apiKey: goodKey });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain('did not accept');
    expect((await admin.get('/api/admin/assistant-key')).body).toMatchObject({ source: 'environment' });
  });

  it('saves a working key encrypted, shows only its last 4 characters, and the assistant uses it', async () => {
    const admin = await signIn('boss@test.com');
    retrieve.mockResolvedValueOnce({ id: 'claude-sonnet-5-5' });
    const saved = await admin.put('/api/admin/assistant-key').send({ apiKey: goodKey });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, source: 'settings', last4: 'WXYZ' });
    expect(JSON.stringify(saved.body)).not.toContain(goodKey);
    expect(await getSecret('anthropic_api_key')).not.toContain('WXYZ');
    expect(JSON.stringify((await admin.get('/api/admin/settings')).body)).not.toContain('anthropic');

    create.mockResolvedValueOnce(reply([text('Hello')]));
    await admin.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(constructed.at(-1)).toMatchObject({ apiKey: goodKey });

    const removed = await admin.delete('/api/admin/assistant-key');
    expect(removed.body).toMatchObject({ source: 'environment', last4: 'ENVK' });
  });

  it('ignores a malformed key in the server environment', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-Ab...XyZ';
    try {
      const admin = await signIn('boss@test.com');
      expect((await admin.get('/api/admin/assistant-key')).body).toMatchObject({ configured: false });
      expect((await admin.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(503);
    } finally {
      process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it('is for administrators only', async () => {
    const staff = await signIn();
    expect((await staff.get('/api/admin/assistant-key')).status).toBe(403);
    expect((await staff.put('/api/admin/assistant-key').send({ apiKey: goodKey })).status).toBe(403);
  });
});
