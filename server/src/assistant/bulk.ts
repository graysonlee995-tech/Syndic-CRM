import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { query, value } from '../db/index.js';
import {
  audit,
  createClient,
  createDocument,
  createLoyalty,
  getClient,
  getDocument,
  isTrashed,
  moveToTrash,
  reindexClient,
  timezone,
  setClientActive,
  updateClient,
  updateDocument,
  type ClientInput,
  type PublicUser,
  type TrashKind,
} from '../db/repo.js';
import { createCompany, getCompany, updateCompany } from '../db/companies.js';
import { createTrip, getTrip, tripIdByReference } from '../db/trips.js';
import { listQcItems, QC_ANSWERS, saveTripQc } from '../db/quality.js';
import { todayInTz } from '../lib/dates.js';
import { clientSchema, companySchema, documentSchema, loyaltySchema, tripSchema } from '../routes/schemas.js';
import { can, type Section } from '../auth/permissions.js';

/**
 * The assistant's add / edit / trash tools. Each takes a list, so a whole sheet
 * is one action: the employee sees one preview table (rows with problems are
 * listed and skipped) and approves or declines it once. Nothing is deleted
 * permanently; trash can be restored by an admin.
 */

type Tool = Anthropic.Beta.BetaTool;

const VIA = ' (via assistant)';
const MAX_ROWS = 500;

/** One row of a preview: what will happen, or why the row is skipped. */
interface PlannedRow {
  cells: string[];
  problem?: string;
}

export interface Preview {
  columns: string[];
  rows: PlannedRow[];
}

const zodProblem = (err: z.ZodError) => {
  const i = err.issues[0];
  return `${i.path.join(' ') || 'value'}: ${i.message}`;
};

const docProps = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['passport', 'residence_permit', 'visa', 'driving_licence', 'ktn', 'other'], description: 'residence_permit = Residence Card; driving_licence = Driver\'s License' },
    other_type: { type: 'string', description: 'Required for type "other": what the document is' },
    document_number: { type: 'string' },
    issuing_country: { type: 'string', description: 'Country code or name, e.g. PK or Pakistan' },
    issue_date: { type: 'string', description: 'YYYY-MM-DD' },
    expiry_date: { type: 'string', description: 'YYYY-MM-DD' },
    notes: { type: 'string' },
  },
  required: ['type'],
} as const;

const loyaltyProps = {
  type: 'object',
  properties: {
    airline: { type: 'string', description: 'Provider: airline, hotel chain or car rental company' },
    programme: { type: 'string' },
    member_number: { type: 'string' },
    tier: { type: 'string' },
  },
  required: ['airline', 'member_number'],
} as const;

const travellerFields = {
  first_name: { type: 'string', description: 'Given name' },
  last_name: { type: 'string' },
  company_ids: { type: 'array', items: { type: 'integer' }, description: 'Every company the traveller belongs to (a traveller can belong to several)' },
  company_names: {
    type: 'array',
    items: { type: 'string' },
    description: 'Instead of (or as well as) company_ids: exact names of existing companies, or of ones created in the same batch',
  },
  date_of_birth: { type: 'string', description: 'YYYY-MM-DD' },
  gender: { type: 'string', enum: ['Male', 'Female', 'Other'] },
  nationality: { type: 'string', description: 'Country code or name, e.g. PK or Pakistan' },
  phone: { type: 'string' },
  email: { type: 'string' },
  address_line: { type: 'string' },
  state: { type: 'string' },
  city: { type: 'string' },
  country: { type: 'string', description: 'Country code or name' },
  seat_preference: { type: 'string', enum: ['Window', 'Aisle', 'Middle', 'No preference'] },
  cabin_preference: { type: 'string', enum: ['Economy', 'Premium economy', 'Business', 'First'] },
  meal_preference: { type: 'string' },
  special_requirements: { type: 'string' },
  notes: { type: 'string' },
  sabre_entries: { type: 'array', items: { type: 'string' }, description: 'Sabre Entries, one line each' },
} as const;

const companyFields = {
  name: { type: 'string' },
  primary_contact: { type: 'string' },
  phone: { type: 'string' },
  email: { type: 'string' },
  address_line: { type: 'string' },
  state: { type: 'string' },
  city: { type: 'string' },
  country: { type: 'string', description: 'Country code or name' },
  notes: { type: 'string' },
} as const;

export const BULK_TOOLS: Tool[] = [
  {
    name: 'create_travellers',
    description:
      'Add travellers (one or many, e.g. every row of an attached sheet), optionally with their documents, frequent flyer memberships and Sabre Entries. ' +
      `Up to ${MAX_ROWS} per call. Names are saved in capitals. Travellers that look like existing ones (same name and date of birth, or same email) are skipped; use update_travellers for them. Needs approval.`,
    input_schema: {
      type: 'object',
      properties: {
        travellers: {
          type: 'array',
          maxItems: MAX_ROWS,
          items: {
            type: 'object',
            properties: { ...travellerFields, documents: { type: 'array', items: docProps }, frequent_flyer: { type: 'array', items: loyaltyProps } },
            required: ['first_name', 'last_name'],
          },
        },
      },
      required: ['travellers'],
    },
  },
  {
    name: 'update_travellers',
    description:
      'Change existing travellers (by id from search_travellers or get_traveller): any of their fields, and/or add documents, frequent flyer memberships or Sabre Entry lines. ' +
      'Only the fields given change. To replace all Sabre Entries send sabre_entries; to append lines send add_sabre_entries. Needs approval.',
    input_schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          maxItems: MAX_ROWS,
          items: {
            type: 'object',
            properties: {
              traveller_id: { type: 'integer' },
              ...travellerFields,
              active: { type: 'boolean', description: 'false makes the traveller inactive: their documents then raise no expiry alerts; true makes them active again' },
              add_company_ids: { type: 'array', items: { type: 'integer' }, description: 'Companies to add, keeping the ones the traveller has' },
              add_company_names: { type: 'array', items: { type: 'string' }, description: 'Companies to add by exact name, keeping the ones the traveller has' },
              add_sabre_entries: { type: 'array', items: { type: 'string' } },
              add_documents: { type: 'array', items: docProps },
              add_frequent_flyer: { type: 'array', items: loyaltyProps },
            },
            required: ['traveller_id'],
          },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'update_documents',
    description: "Change a traveller's document (by document id from get_traveller): number, issuing country, dates, type or notes. Needs approval.",
    input_schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          maxItems: MAX_ROWS,
          items: { type: 'object', properties: { document_id: { type: 'integer' }, ...docProps.properties }, required: ['document_id'] },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'create_companies',
    description: `Add companies (one or many). Up to ${MAX_ROWS} per call. Names are saved in capitals; a company whose name already exists is skipped. Needs approval.`,
    input_schema: {
      type: 'object',
      properties: { companies: { type: 'array', maxItems: MAX_ROWS, items: { type: 'object', properties: companyFields, required: ['name'] } } },
      required: ['companies'],
    },
  },
  {
    name: 'update_companies',
    description: 'Change existing companies (by id from search_companies). Only the fields given change. Needs approval.',
    input_schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          maxItems: MAX_ROWS,
          items: { type: 'object', properties: { company_id: { type: 'integer' }, ...companyFields }, required: ['company_id'] },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'set_quality_check',
    description:
      "Answer items of a trip's quality checklist (see get_trip for the items). Each answer is verified, not_available or not_required; null clears it. Needs approval.",
    input_schema: {
      type: 'object',
      properties: {
        trip: { type: 'string', description: 'Trip reference such as TRP-2026-00012, or the numeric trip id' },
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { item: { type: 'string', description: 'Checklist item name, e.g. "Passport valid"' }, answer: { type: ['string', 'null'], enum: [...QC_ANSWERS, null] } },
            required: ['item', 'answer'],
          },
        },
      },
      required: ['trip', 'answers'],
    },
  },
  {
    name: 'move_to_trash',
    description:
      'Move trips, companies or travellers to the Trash (they can be restored; nothing is deleted permanently). Needs the employee\'s Delete permission for that section. Needs approval.',
    input_schema: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          maxItems: MAX_ROWS,
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['trip', 'company', 'traveller'] }, id: { type: 'integer' } }, required: ['kind', 'id'] },
        },
      },
      required: ['records'],
    },
  },
  {
    name: 'create_trips',
    description:
      'Create trips (one or many). Each needs a name and at least one itinerary item with a departure date; look up company and traveller ids first. Needs approval.',
    input_schema: {
      type: 'object',
      properties: {
        trips: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              company_id: { type: 'integer' },
              traveller_ids: { type: 'array', items: { type: 'integer' } },
              trip_type: { type: 'string', enum: ['business', 'leisure', 'group', 'event', 'other'] },
              status: { type: 'string', enum: ['active', 'inactive', 'cancelled'] },
              notes: { type: 'string' },
              itinerary: { type: 'array', items: { type: 'object' }, description: 'Items as for add_itinerary_items', minItems: 1 },
            },
            required: ['name', 'itinerary'],
          },
        },
      },
      required: ['trips'],
    },
  },
];

export const BULK_WRITE_TOOLS = new Set(BULK_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------- shared helpers

const list = (input: Record<string, unknown>, key: string) => (Array.isArray(input[key]) ? (input[key] as Record<string, unknown>[]) : []).slice(0, MAX_ROWS);
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const sabreText = (lines: unknown) => (Array.isArray(lines) ? lines.map((l) => String(l).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n') : null);

const COMPANY_KEYS_OF_TRAVELLER = ['company_ids', 'company_names', 'company_id', 'company_name'];
const TRAVELLER_KEYS = Object.keys(travellerFields).filter((k) => !COMPANY_KEYS_OF_TRAVELLER.includes(k) && k !== 'sabre_entries') as (keyof ClientInput)[];

/**
 * The companies a row names, by id and/or name (single company_id / company_name
 * are accepted too). Names of companies created in the same batch are returned
 * separately, to be looked up once they exist.
 */
async function rowCompanies(row: Record<string, unknown>, prefix: '' | 'add_', ctx: BatchContext) {
  const ids = [...(Array.isArray(row[`${prefix}company_ids`]) ? (row[`${prefix}company_ids`] as unknown[]) : []), ...(row[`${prefix}company_id`] ? [row[`${prefix}company_id`]] : [])].map(Number);
  const names = [
    ...(Array.isArray(row[`${prefix}company_names`]) ? (row[`${prefix}company_names`] as unknown[]) : []),
    ...(row[`${prefix}company_name`] ? [row[`${prefix}company_name`]] : []),
  ].map((n) => String(n).trim()).filter(Boolean);
  const pending: string[] = [];
  for (const id of ids) if (!(await getCompany(id))) return { problem: `company #${id} not found` };
  for (const name of names) {
    const id = await companyIdByName(name);
    if (id) ids.push(id);
    else if (ctx.newCompanyNames.has(name.toUpperCase())) pending.push(name);
    else return { problem: `company "${name}" not found; add it first or leave it out` };
  }
  const given = ids.length > 0 || names.length > 0 || COMPANY_KEYS_OF_TRAVELLER.some((k) => `${prefix}${k}` in row);
  return { ids: [...new Set(ids)], pending, given };
}

async function companyIdByName(name: string): Promise<number | null> {
  return (await value<number | undefined>('SELECT id FROM companies WHERE deleted_at IS NULL AND upper(name) = upper(?)', [name.trim()])) ?? null;
}

/** An existing traveller that looks like this one: same name and date of birth, or same email. */
async function possibleDuplicate(c: { first_name: string; last_name: string; date_of_birth: string | null; email: string | null }) {
  const rows = await query<{ id: number }>(
    `SELECT id FROM clients WHERE deleted_at IS NULL AND (
       (upper(first_name) = upper(@first) AND upper(last_name) = upper(@last) AND date_of_birth IS NOT DISTINCT FROM @dob)
       OR (@email::text IS NOT NULL AND lower(email) = lower(@email)))
     LIMIT 1`,
    { first: c.first_name, last: c.last_name, dob: c.date_of_birth, email: c.email },
  );
  return rows[0]?.id ?? null;
}

const code = (id: number) => `T-${String(id).padStart(4, '0')}`;

/** Company names created by other actions approved together with this one. */
export interface BatchContext {
  newCompanyNames: Set<string>;
}

// ---------------------------------------------------------------- travellers

async function planTraveller(row: Record<string, unknown>, ctx: BatchContext) {
  const companies = await rowCompanies(row, '', ctx);
  if (companies.problem) return { problem: companies.problem };
  const names = await Promise.all((companies.ids ?? []).map(async (id) => (await getCompany(id))?.name ?? `#${id}`));
  const companyNote = [...names, ...(companies.pending ?? []).map((n) => `${n.toUpperCase()} (new)`)].join(', ');
  const parsed = clientSchema.safeParse({ ...Object.fromEntries(TRAVELLER_KEYS.map((k) => [k, row[k]])), company_ids: companies.ids, sabre_entry: sabreText(row.sabre_entries) });
  if (!parsed.success) return { problem: zodProblem(parsed.error) };
  const docs = list(row, 'documents').map((d) => documentSchema.safeParse(d));
  const badDoc = docs.find((d) => !d.success);
  if (badDoc && !badDoc.success) return { problem: `document ${zodProblem(badDoc.error)}` };
  const ff = list(row, 'frequent_flyer').map((f) => loyaltySchema.safeParse(f));
  const badFf = ff.find((f) => !f.success);
  if (badFf && !badFf.success) return { problem: `frequent flyer ${zodProblem(badFf.error)}` };
  return {
    data: parsed.data,
    companyName: companyNote,
    pendingCompanies: companies.pending ?? [],
    documents: docs.flatMap((d) => (d.success ? [d.data] : [])),
    loyalty: ff.flatMap((f) => (f.success ? [f.data] : [])),
  };
}

async function previewCreateTravellers(input: Record<string, unknown>, ctx: BatchContext): Promise<Preview> {
  const rows: PlannedRow[] = [];
  const seen = new Set<string>();
  for (const row of list(input, 'travellers')) {
    const plan = await planTraveller(row, ctx);
    const name = `${s(row.first_name).toUpperCase()} ${s(row.last_name).toUpperCase()}`.trim();
    const base = [name, s(row.date_of_birth), s(plan.data?.nationality ?? row.nationality), plan.companyName ?? '', `${plan.documents?.length ?? 0} doc(s)`];
    if (!plan.data) {
      rows.push({ cells: base, problem: plan.problem });
      continue;
    }
    const key = `${plan.data.first_name}|${plan.data.last_name}|${plan.data.date_of_birth ?? ''}`;
    const dup = seen.has(key) ? 'listed twice in this batch' : await possibleDuplicate(plan.data).then((id) => (id ? `looks like existing traveller ${code(id)}` : ''));
    seen.add(key);
    rows.push({ cells: base, problem: dup || undefined });
  }
  return { columns: ['Traveller', 'Date of birth', 'Nationality', 'Company', 'Documents'], rows };
}

async function runCreateTravellers(input: Record<string, unknown>, user: PublicUser, ctx: BatchContext) {
  const created: { id: number; name: string; link: string }[] = [];
  const skipped: { row: number; name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const [i, row] of list(input, 'travellers').entries()) {
    const name = `${s(row.first_name)} ${s(row.last_name)}`.trim();
    const plan = await planTraveller(row, ctx);
    if (!plan.data) {
      skipped.push({ row: i + 1, name, reason: plan.problem ?? 'invalid' });
      continue;
    }
    const data = { ...plan.data };
    // Companies created earlier in this batch exist now.
    for (const pendingName of plan.pendingCompanies ?? []) {
      const id = await companyIdByName(pendingName);
      if (id) data.company_ids = [...new Set([...data.company_ids, id])];
    }
    const key = `${data.first_name}|${data.last_name}|${data.date_of_birth ?? ''}`;
    const dup = seen.has(key) ? 'listed twice in this batch' : await possibleDuplicate(data).then((id) => (id ? `looks like existing traveller ${code(id)}` : ''));
    seen.add(key);
    if (dup) {
      skipped.push({ row: i + 1, name, reason: dup });
      continue;
    }
    const id = await createClient(data, user.id);
    for (const d of plan.documents ?? []) await createDocument(id, d, null, user.id);
    for (const f of plan.loyalty ?? []) await createLoyalty(id, f);
    await audit(user, 'client_created', 'client', id, `${data.first_name} ${data.last_name}${VIA}`);
    created.push({ id, name: `${data.first_name} ${data.last_name}`, link: `/travellers/${id}` });
  }
  return { created: created.length, travellers: created, skipped };
}

async function planTravellerUpdate(row: Record<string, unknown>) {
  const id = Number(row.traveller_id);
  const current = await getClient(id);
  if (!current) return { problem: `traveller #${row.traveller_id} not found` };
  const changes: Record<string, unknown> = Object.fromEntries(TRAVELLER_KEYS.filter((k) => k in row).map((k) => [k, row[k]]));
  // company_ids / company_names replace the list; add_company_ids / add_company_names add to it.
  const noBatch: BatchContext = { newCompanyNames: new Set() };
  const replace = await rowCompanies(row, '', noBatch);
  if (replace.problem) return { problem: replace.problem };
  const add = await rowCompanies(row, 'add_', noBatch);
  if (add.problem) return { problem: add.problem };
  if (replace.given || add.given) {
    const ids = [...new Set([...(replace.given ? (replace.ids ?? []) : current.company_ids), ...(add.ids ?? [])])];
    if (ids.join() !== current.company_ids.join()) changes.companies = ids;
  }
  let sabre = current.sabre_entry;
  if (row.sabre_entries !== undefined) sabre = sabreText(row.sabre_entries);
  if (Array.isArray(row.add_sabre_entries)) sabre = [sabre, sabreText(row.add_sabre_entries)].filter(Boolean).join('\n');
  const { companies: newCompanies, ...fieldChanges } = changes;
  const merged = {
    ...Object.fromEntries(TRAVELLER_KEYS.map((k) => [k, current[k]])),
    ...fieldChanges,
    company_ids: (newCompanies as number[] | undefined) ?? current.company_ids,
    sabre_entry: sabre,
  };
  const parsed = clientSchema.safeParse(merged);
  if (!parsed.success) return { problem: zodProblem(parsed.error) };
  const docs = list(row, 'add_documents').map((d) => documentSchema.safeParse(d));
  const badDoc = docs.find((d) => !d.success);
  if (badDoc && !badDoc.success) return { problem: `document ${zodProblem(badDoc.error)}` };
  const ff = list(row, 'add_frequent_flyer').map((f) => loyaltySchema.safeParse(f));
  const badFf = ff.find((f) => !f.success);
  if (badFf && !badFf.success) return { problem: `frequent flyer ${zodProblem(badFf.error)}` };
  const activeChange = typeof row.active === 'boolean' && row.active !== Boolean(current.is_active) ? (row.active as boolean) : null;
  const what = [
    ...(activeChange === null ? [] : [activeChange ? 'make active' : 'make inactive']),
    ...Object.keys(changes),
    ...(sabre !== current.sabre_entry ? ['sabre entries'] : []),
    ...(docs.length ? [`+${docs.length} document(s)`] : []),
    ...(ff.length ? [`+${ff.length} frequent flyer`] : []),
  ];
  return {
    id,
    name: `${current.first_name} ${current.last_name}`,
    data: parsed.data,
    what,
    activeChange,
    documents: docs.flatMap((d) => (d.success ? [d.data] : [])),
    loyalty: ff.flatMap((f) => (f.success ? [f.data] : [])),
  };
}

async function previewUpdateTravellers(input: Record<string, unknown>): Promise<Preview> {
  const rows: PlannedRow[] = [];
  for (const row of list(input, 'updates')) {
    const plan = await planTravellerUpdate(row);
    rows.push({
      cells: [plan.id ? code(plan.id) : `#${s(row.traveller_id)}`, plan.name ?? '', (plan.what ?? []).join(', ').replace(/_/g, ' ') || '-'],
      problem: plan.problem ?? (plan.what && !plan.what.length ? 'nothing to change' : undefined),
    });
  }
  return { columns: ['ID', 'Traveller', 'Changes'], rows };
}

async function runUpdateTravellers(input: Record<string, unknown>, user: PublicUser) {
  const updated: { id: number; name: string; link: string }[] = [];
  const skipped: { traveller_id: unknown; reason: string }[] = [];
  for (const row of list(input, 'updates')) {
    const plan = await planTravellerUpdate(row);
    if (!plan.data || !plan.id) {
      skipped.push({ traveller_id: row.traveller_id, reason: plan.problem ?? 'invalid' });
      continue;
    }
    await updateClient(plan.id, plan.data);
    if (plan.activeChange !== null && plan.activeChange !== undefined) await setClientActive(plan.id, plan.activeChange);
    for (const d of plan.documents ?? []) await createDocument(plan.id, d, null, user.id);
    for (const f of plan.loyalty ?? []) await createLoyalty(plan.id, f);
    await reindexClient(plan.id);
    await audit(user, 'client_updated', 'client', plan.id, `${(plan.what ?? []).join(', ')}${VIA}`);
    updated.push({ id: plan.id, name: plan.name ?? '', link: `/travellers/${plan.id}` });
  }
  return { updated: updated.length, travellers: updated, skipped };
}

// ---------------------------------------------------------------- documents

async function planDocumentUpdate(row: Record<string, unknown>) {
  const doc = await getDocument(Number(row.document_id));
  if (!doc || !(await getClient(doc.client_id))) return { problem: `document #${row.document_id} not found` };
  const keys = Object.keys(docProps.properties).filter((k) => k in row);
  const merged = { ...Object.fromEntries(Object.keys(docProps.properties).map((k) => [k, doc[k as keyof typeof doc]])), ...Object.fromEntries(keys.map((k) => [k, row[k]])) };
  const parsed = documentSchema.safeParse(merged);
  if (!parsed.success) return { problem: zodProblem(parsed.error) };
  return { doc, data: parsed.data, what: keys };
}

async function previewUpdateDocuments(input: Record<string, unknown>): Promise<Preview> {
  const rows: PlannedRow[] = [];
  for (const row of list(input, 'updates')) {
    const plan = await planDocumentUpdate(row);
    rows.push({ cells: [`#${s(row.document_id)}`, plan.doc ? code(plan.doc.client_id) : '', (plan.what ?? []).join(', ').replace(/_/g, ' ')], problem: plan.problem });
  }
  return { columns: ['Document', 'Traveller', 'Changes'], rows };
}

async function runUpdateDocuments(input: Record<string, unknown>, user: PublicUser) {
  let updated = 0;
  const skipped: { document_id: unknown; reason: string }[] = [];
  for (const row of list(input, 'updates')) {
    const plan = await planDocumentUpdate(row);
    if (!plan.data || !plan.doc) {
      skipped.push({ document_id: row.document_id, reason: plan.problem ?? 'invalid' });
      continue;
    }
    await updateDocument(plan.doc.id, plan.data, null, user.id);
    await audit(user, 'document_updated', 'client', plan.doc.client_id, `${plan.what?.join(', ')}${VIA}`);
    updated++;
  }
  return { updated, skipped };
}

// ---------------------------------------------------------------- companies

const COMPANY_KEYS = Object.keys(companyFields);

async function previewCreateCompanies(input: Record<string, unknown>): Promise<Preview> {
  const rows: PlannedRow[] = [];
  const seen = new Set<string>();
  for (const row of list(input, 'companies')) {
    const parsed = companySchema.safeParse(Object.fromEntries(COMPANY_KEYS.map((k) => [k, row[k]])));
    const name = s(row.name).toUpperCase();
    let problem = parsed.success ? undefined : zodProblem(parsed.error);
    if (!problem && (seen.has(name) || (await companyIdByName(name)))) problem = seen.has(name) ? 'listed twice in this batch' : 'a company with this name already exists';
    seen.add(name);
    rows.push({ cells: [name, s(row.city), s(parsed.success ? parsed.data.country : row.country), s(row.email)], problem });
  }
  return { columns: ['Company', 'City', 'Country', 'Email'], rows };
}

async function runCreateCompanies(input: Record<string, unknown>, user: PublicUser) {
  const created: { id: number; name: string; link: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const row of list(input, 'companies')) {
    const parsed = companySchema.safeParse(Object.fromEntries(COMPANY_KEYS.map((k) => [k, row[k]])));
    if (!parsed.success) {
      skipped.push({ name: s(row.name), reason: zodProblem(parsed.error) });
      continue;
    }
    if (await companyIdByName(parsed.data.name)) {
      skipped.push({ name: parsed.data.name, reason: 'a company with this name already exists' });
      continue;
    }
    const id = await createCompany(parsed.data, user.id);
    await audit(user, 'company_created', 'company', id, `${parsed.data.name}${VIA}`);
    created.push({ id, name: parsed.data.name, link: `/companies/${id}` });
  }
  return { created: created.length, companies: created, skipped };
}

async function planCompanyUpdate(row: Record<string, unknown>) {
  const current = await getCompany(Number(row.company_id));
  if (!current) return { problem: `company #${row.company_id} not found` };
  const keys = COMPANY_KEYS.filter((k) => k in row);
  const parsed = companySchema.safeParse({ ...Object.fromEntries(COMPANY_KEYS.map((k) => [k, current[k as keyof typeof current]])), ...Object.fromEntries(keys.map((k) => [k, row[k]])) });
  if (!parsed.success) return { problem: zodProblem(parsed.error) };
  return { current, data: parsed.data, what: keys };
}

async function previewUpdateCompanies(input: Record<string, unknown>): Promise<Preview> {
  const rows: PlannedRow[] = [];
  for (const row of list(input, 'updates')) {
    const plan = await planCompanyUpdate(row);
    rows.push({ cells: [plan.current?.name ?? `#${s(row.company_id)}`, (plan.what ?? []).join(', ').replace(/_/g, ' ') || '-'], problem: plan.problem ?? (plan.what && !plan.what.length ? 'nothing to change' : undefined) });
  }
  return { columns: ['Company', 'Changes'], rows };
}

async function runUpdateCompanies(input: Record<string, unknown>, user: PublicUser) {
  let updated = 0;
  const skipped: { company_id: unknown; reason: string }[] = [];
  for (const row of list(input, 'updates')) {
    const plan = await planCompanyUpdate(row);
    if (!plan.data || !plan.current) {
      skipped.push({ company_id: row.company_id, reason: plan.problem ?? 'invalid' });
      continue;
    }
    await updateCompany(plan.current.id, plan.data);
    await audit(user, 'company_updated', 'company', plan.current.id, `${plan.what?.join(', ')}${VIA}`);
    updated++;
  }
  return { updated, skipped };
}

// ---------------------------------------------------------------- trips

async function resolveTripId(raw: unknown): Promise<number | null> {
  const text = String(raw ?? '').trim();
  const id = /^\d+$/.test(text) ? Number(text) : await tripIdByReference(text);
  return id && (await getTrip(id, todayInTz(timezone()))) ? id : null;
}

async function planTrip(row: Record<string, unknown>) {
  const parsed = tripSchema.safeParse(row);
  if (!parsed.success) return { problem: zodProblem(parsed.error) };
  if (!parsed.data.itinerary.length) return { problem: 'needs at least one itinerary item with a departure date' };
  if (parsed.data.company_id && !(await getCompany(parsed.data.company_id))) return { problem: `company #${parsed.data.company_id} not found` };
  for (const id of parsed.data.traveller_ids) if (!(await getClient(id))) return { problem: `traveller #${id} not found` };
  return { data: parsed.data };
}

async function previewCreateTrips(input: Record<string, unknown>): Promise<Preview> {
  const rows: PlannedRow[] = [];
  for (const row of list(input, 'trips')) {
    const plan = await planTrip(row);
    const first = plan.data?.itinerary[0];
    rows.push({
      cells: [s(row.name), first ? `${first.departure_date}` : '', `${Array.isArray(row.itinerary) ? row.itinerary.length : 0} item(s)`, `${Array.isArray(row.traveller_ids) ? row.traveller_ids.length : 0}`],
      problem: plan.problem,
    });
  }
  return { columns: ['Trip', 'Starts', 'Itinerary', 'Travellers'], rows };
}

async function runCreateTrips(input: Record<string, unknown>, user: PublicUser) {
  const created: { reference: string; id: number; link: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const row of list(input, 'trips')) {
    const plan = await planTrip(row);
    if (!plan.data) {
      skipped.push({ name: s(row.name), reason: plan.problem ?? 'invalid' });
      continue;
    }
    const id = await createTrip(plan.data, user.id);
    const trip = (await getTrip(id, todayInTz(timezone())))!;
    await audit(user, 'trip_created', 'trip', id, `${trip.reference} ${trip.name}${VIA}`);
    created.push({ reference: trip.reference, id, link: `/trips/${id}` });
  }
  return { created: created.length, trips: created, skipped };
}

async function planQc(input: Record<string, unknown>) {
  const tripId = await resolveTripId(input.trip);
  if (!tripId) return { problem: `trip "${s(input.trip)}" not found` };
  const items = await listQcItems(true);
  const answers: { item_id: number; answer: (typeof QC_ANSWERS)[number] | null; label: string }[] = [];
  const problems: string[] = [];
  for (const a of list(input, 'answers')) {
    const item = items.find((i) => i.label.toLowerCase() === s(a.item).trim().toLowerCase());
    if (!item) problems.push(`no checklist item "${s(a.item)}"`);
    else if (a.answer !== null && !(QC_ANSWERS as readonly string[]).includes(s(a.answer))) problems.push(`"${s(a.answer)}" is not an answer`);
    else answers.push({ item_id: item.id, label: item.label, answer: (a.answer as (typeof QC_ANSWERS)[number] | null) ?? null });
  }
  return { tripId, answers, problems };
}

async function previewQc(input: Record<string, unknown>): Promise<Preview> {
  const plan = await planQc(input);
  if (!plan.tripId) return { columns: ['Item', 'Answer'], rows: [{ cells: [s(input.trip), ''], problem: plan.problem }] };
  return {
    columns: ['Item', 'Answer'],
    rows: [
      ...plan.answers.map((a) => ({ cells: [a.label, a.answer ? a.answer.replace(/_/g, ' ') : '(clear)'] })),
      ...plan.problems.map((p) => ({ cells: ['', ''], problem: p })),
    ],
  };
}

async function runQc(input: Record<string, unknown>, user: PublicUser) {
  const plan = await planQc(input);
  if (!plan.tripId) return { error: plan.problem };
  const result = await saveTripQc(plan.tripId, plan.answers, user.id);
  await audit(user, result.newlyPassed ? 'trip_qc_passed' : 'trip_qc_updated', 'trip', plan.tripId, `${plan.answers.length} item(s) answered${VIA}`);
  return { trip_id: plan.tripId, answered: plan.answers.length, passed: result.passed, skipped: plan.problems };
}

// ---------------------------------------------------------------- trash

const TRASH_KIND: Record<string, TrashKind> = { trip: 'trip', company: 'company', traveller: 'client' };
const SECTION_OF_KIND: Record<string, Section> = { trip: 'trips', company: 'companies', traveller: 'travellers' };

async function describeRecord(kind: string, id: number): Promise<string | null> {
  if (kind === 'trip') {
    const t = await getTrip(id, todayInTz(timezone()));
    return t ? `${t.reference} ${t.name}` : null;
  }
  if (kind === 'company') return (await getCompany(id))?.name ?? null;
  const c = await getClient(id);
  return c ? `${c.first_name} ${c.last_name}` : null;
}

async function previewTrash(input: Record<string, unknown>, user: PublicUser): Promise<Preview> {
  const rows: PlannedRow[] = [];
  for (const r of list(input, 'records')) {
    const label = TRASH_KIND[s(r.kind)] ? await describeRecord(s(r.kind), Number(r.id)) : null;
    rows.push({
      cells: [s(r.kind), label ?? `#${s(r.id)}`],
      problem: !TRASH_KIND[s(r.kind)]
        ? 'unknown kind'
        : !can(user, SECTION_OF_KIND[s(r.kind)], 'delete')
          ? `you don't have permission to delete ${SECTION_OF_KIND[s(r.kind)]}`
          : label
            ? undefined
            : 'not found (or already in the Trash)',
    });
  }
  return { columns: ['Kind', 'Record'], rows };
}

async function runTrash(input: Record<string, unknown>, user: PublicUser) {
  const trashed: string[] = [];
  const skipped: { kind: string; id: unknown; reason: string }[] = [];
  for (const r of list(input, 'records')) {
    const kind = TRASH_KIND[s(r.kind)];
    const label = kind ? await describeRecord(s(r.kind), Number(r.id)) : null;
    if (!kind || !label || (await isTrashed(kind, Number(r.id)))) {
      skipped.push({ kind: s(r.kind), id: r.id, reason: 'not found' });
      continue;
    }
    if (!can(user, SECTION_OF_KIND[s(r.kind)], 'delete')) {
      skipped.push({ kind: s(r.kind), id: r.id, reason: `no permission to delete ${SECTION_OF_KIND[s(r.kind)]}` });
      continue;
    }
    await moveToTrash(kind, Number(r.id));
    await audit(user, `${kind}_trashed`, kind, Number(r.id), `${label}${VIA}`);
    trashed.push(label);
  }
  return { moved_to_trash: trashed, skipped };
}

// ---------------------------------------------------------------- entry points

export async function previewBulk(name: string, input: Record<string, unknown>, user: PublicUser, ctx: BatchContext): Promise<Preview | null> {
  switch (name) {
    case 'create_travellers':
      return previewCreateTravellers(input, ctx);
    case 'update_travellers':
      return previewUpdateTravellers(input);
    case 'update_documents':
      return previewUpdateDocuments(input);
    case 'create_companies':
      return previewCreateCompanies(input);
    case 'update_companies':
      return previewUpdateCompanies(input);
    case 'create_trips':
      return previewCreateTrips(input);
    case 'set_quality_check':
      return previewQc(input);
    case 'move_to_trash':
      return previewTrash(input, user);
    default:
      return null;
  }
}

export async function runBulk(name: string, input: Record<string, unknown>, user: PublicUser, ctx: BatchContext): Promise<unknown> {
  switch (name) {
    case 'create_travellers':
      return runCreateTravellers(input, user, ctx);
    case 'update_travellers':
      return runUpdateTravellers(input, user);
    case 'update_documents':
      return runUpdateDocuments(input, user);
    case 'create_companies':
      return runCreateCompanies(input, user);
    case 'update_companies':
      return runUpdateCompanies(input, user);
    case 'create_trips':
      return runCreateTrips(input, user);
    case 'set_quality_check':
      return runQc(input, user);
    case 'move_to_trash':
      return runTrash(input, user);
    default:
      throw new Error(`Unknown bulk tool ${name}`);
  }
}

/** Company names a batch of pending actions will create, so travellers in the same batch can use them. */
export function batchContext(uses: { name: string; input: unknown }[]): BatchContext {
  const names = uses
    .filter((u) => u.name === 'create_companies')
    .flatMap((u) => list(u.input as Record<string, unknown>, 'companies').map((c) => s(c.name).trim().toUpperCase()));
  return { newCompanyNames: new Set(names) };
}

/** Writes run one after another in this order, so companies exist before travellers that use them. */
export const WRITE_ORDER = ['create_companies', 'update_companies', 'create_travellers', 'update_travellers', 'update_documents', 'create_trips'];
