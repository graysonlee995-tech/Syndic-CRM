/**
 * Creates an employee account from the command line (used for the first admin).
 *   npm run create-user -- --email you@agency.com --name "Your Name" --role admin
 * A random password is generated and printed unless --password is given.
 */
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import { createUser, getUserByEmail, type Role } from '../db/repo.js';
import { pool } from '../db/index.js';
import { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH } from '../routes/auth.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'admin' },
    password: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { email, name, role } = values;
if (!email || !name) fail('Usage: npm run create-user -- --email <email> --name "<full name>" [--role admin|staff] [--password <password>]');
if (role !== 'admin' && role !== 'staff') fail('--role must be admin or staff');
if (await getUserByEmail(email)) fail(`An employee with email ${email} already exists`);

const password = values.password ?? crypto.randomBytes(12).toString('base64url');
if (password.length < MIN_PASSWORD_LENGTH) fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

await createUser({ name, email, role: role as Role, passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS), receivesAlerts: role === 'admin' });

console.log(`Created ${role} account for ${name} <${email}>`);
if (!values.password) {
  console.log(`Temporary password: ${password}`);
  console.log('Sign in and change it under "My account".');
}
await pool.end();
