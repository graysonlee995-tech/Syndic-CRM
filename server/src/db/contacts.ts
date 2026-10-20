import { query, run, tx } from './index.js';

/** Extra phone numbers and addresses of a company or a traveller (beyond the main ones). */

export interface PhoneInput {
  label: string | null;
  number: string;
}

export interface AddressInput {
  label: string | null;
  address_line: string | null;
  state: string | null;
  city: string | null;
  country: string | null;
}

export interface Contacts {
  phones: (PhoneInput & { id: number })[];
  addresses: (AddressInput & { id: number })[];
}

export type ContactOwner = { kind: 'company' | 'client'; id: number };

const ownerColumn = (owner: ContactOwner) => (owner.kind === 'company' ? 'company_id' : 'client_id');

export async function listContacts(owner: ContactOwner): Promise<Contacts> {
  const col = ownerColumn(owner);
  return {
    phones: await query(`SELECT id, label, number FROM contact_phones WHERE ${col} = ? ORDER BY position, id`, [owner.id]),
    addresses: await query(
      `SELECT id, label, address_line, state, city, country FROM contact_addresses WHERE ${col} = ? ORDER BY position, id`,
      [owner.id],
    ),
  };
}

/** Replaces the extra phones and/or addresses; a list left undefined is not touched. */
export function replaceContacts(owner: ContactOwner, phones?: PhoneInput[], addresses?: AddressInput[]): Promise<void> {
  const col = ownerColumn(owner);
  return tx(async () => {
    if (phones) {
      await run(`DELETE FROM contact_phones WHERE ${col} = ?`, [owner.id]);
      for (const [position, p] of phones.entries()) {
        await run(`INSERT INTO contact_phones (${col}, position, label, number) VALUES (?, ?, ?, ?)`, [owner.id, position, p.label, p.number]);
      }
    }
    if (addresses) {
      await run(`DELETE FROM contact_addresses WHERE ${col} = ?`, [owner.id]);
      for (const [position, a] of addresses.entries()) {
        await run(
          `INSERT INTO contact_addresses (${col}, position, label, address_line, state, city, country) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [owner.id, position, a.label, a.address_line, a.state, a.city, a.country],
        );
      }
    }
  });
}

/** Extra phones and addresses of many records as text, for exports: id -> "Mobile: 0300…; Office: 042…". */
export async function contactSummaries(kind: ContactOwner['kind'], ids: number[]): Promise<Map<number, { phones: string; addresses: string }>> {
  const col = kind === 'company' ? 'company_id' : 'client_id';
  const result = new Map<number, { phones: string; addresses: string }>();
  if (!ids.length) return result;
  const list = ids.join(','); // integers from our own query results
  const phones = await query<{ owner: number; label: string | null; number: string }>(
    `SELECT ${col} AS owner, label, number FROM contact_phones WHERE ${col} IN (${list}) ORDER BY position, id`,
  );
  const addresses = await query<{ owner: number; label: string | null; address_line: string | null; state: string | null; city: string | null; country: string | null }>(
    `SELECT ${col} AS owner, label, address_line, state, city, country FROM contact_addresses WHERE ${col} IN (${list}) ORDER BY position, id`,
  );
  const entry = (id: number) => result.get(id) ?? (result.set(id, { phones: '', addresses: '' }), result.get(id)!);
  const join = (a: string, b: string) => (a ? `${a}; ${b}` : b);
  for (const p of phones) entry(p.owner).phones = join(entry(p.owner).phones, `${p.label ? `${p.label}: ` : ''}${p.number}`);
  for (const a of addresses) {
    const text = [a.address_line, a.state, a.city, a.country].filter(Boolean).join(', ');
    entry(a.owner).addresses = join(entry(a.owner).addresses, `${a.label ? `${a.label}: ` : ''}${text}`);
  }
  return result;
}
