import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted stand-in for Claude: each test queues the responses Claude would give.
const { create, retrieve, constructed } = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'e'.repeat(80) + 'ENVK';
  return { create: vi.fn(), retrieve: vi.fn(), constructed: [] as { apiKey?: string }[] };
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
    beta = { messages: { create } };
    models = { retrieve };
    constructor(options: { apiKey?: string } = {}) {
      constructed.push(options);
    }
  }
  return { default: Anthropic };
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
  const empty = { company_id: null, date_of_birth: null, gender: null, nationality: null, phone: null, email: null, address_line: null, state: null, city: null, country: null, seat_preference: null, meal_preference: null, cabin_preference: null, special_requirements: null, notes: null };
  travellerId = await createClient({ ...empty, first_name: 'Hina', last_name: 'Raza' }, user);
});

beforeEach(() => {
  create.mockReset();
  retrieve.mockReset();
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
      reply([toolUse('w1', 'create_trip', { ...tripInput, traveller_ids: [travellerId] })], 'tool_use'),
    );
    const agent = await signIn();
    const first = await agent.post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'Book Hina to Lahore' }] });
    expect(first.body.pending).toEqual([expect.objectContaining({ id: 'w1', name: 'create_trip' })]);
    expect(first.body.pending[0].summary).toContain('Create trip "Lahore Conference"');
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
    create.mockResolvedValueOnce(reply([toolUse('w2', 'create_company', { name: 'Declined Ltd' })], 'tool_use'));
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

  it('requires sign-in', async () => {
    expect((await request(app).post('/api/assistant/chat').send({ messages: [] })).status).toBe(401);
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
