# Syndic CRM

A private CRM for a travel agency. Employees sign in to manage client records and their identity documents (passport, national ID, driving licence, visas), view scans, and get email alerts before documents expire.

## Features

- **Three primary modules, in this order: Trips, Companies, Travellers.** Each has its own listing (search, filters, sortable columns, pagination), add/edit forms and a detail page.
  - **Trips** have their own tables (`trips`, `trip_travellers`, `trip_segments`, `trip_flights`, `trip_flight_tickets`, `trip_ticket_resolutions`, `trip_hotels`, `trip_hotel_guests`, `trip_cars`, `trip_car_passengers`, `trip_cruises`, `trip_documents`) and a reference like `TRP-2026-00012`. Filters: all, upcoming, ongoing, past, cancelled, and trips with open (unused) flight tickets. Each trip has a printable travel agenda (*Print / Save as PDF*).
  - **Companies** can have any number of travellers and trips. The company profile lists them by querying the same trip and traveller records, and can hold optional documents (contracts, travel policies), stored encrypted like traveller scans.
  - Hotels, cars and cruises on a trip can optionally list which of the trip's travellers they cover.
  - **Travellers** (stored in the `clients` table) can belong to a company and have documents, frequent flyer memberships, travel preferences and a trip history.
  - A trip appears in the Trips list, in its company's profile, and in each linked traveller's history. All of these read and edit the **same** trip record.
- **Trash.** Admins can move trips, companies and travellers to the trash. Trashed records are hidden everywhere (including alerts) until restored, and can then be deleted permanently from *Trash*.
- **Activity history** on every trip, company and traveller profile (changes only, from the audit log).
- **Employee-only sign-in.** There is no public sign-up. Accounts lock for 15 minutes after 5 failed attempts, sessions time out after 8 idle hours, and employees can turn on two-factor authentication (an authenticator app) in *My account*.
- **Roles.**
  - **Staff** can view, search, add and edit trips, companies and travellers, manage bookings and tickets, and upload and view documents.
  - **Admin** can also manage employees, choose who receives alerts, change alert settings, move records to the trash and restore or permanently delete them, delete traveller documents, and read the audit log.
- **Search** by name (partial words work), passport or ID number (with or without dashes), address, city, phone, email, or date of birth (`15/03/1985` or `1985-03-15`). You can also filter by date of birth, nationality and document type.
- **Document scans** (PDF, JPG, PNG, WEBP, up to 15 MB) are encrypted (AES-256-GCM) before they are stored, so Supabase Storage only ever holds ciphertext, and only served to signed-in employees. The file type is checked from the file's contents, not the name.
- **Expiry alerts.** A daily job (08:00 by default) emails one summary to every employee with *Receives alerts* switched on. By default it emails 90, 30 and 7 days before expiry and on the expiry day. Each step is sent once per document. Changing a document's expiry date (a renewal) starts its alerts over.
- **Birthday reminders.** The same daily job sends a separate email listing clients whose birthday is within 7 days (you can change this). Each client is included once per year. You can turn this off under *Alert settings*.
- **Dashboard** of expired documents, documents expiring within 7, 30 and 90 days, and client birthdays in the next 30 days.
- **Audit log** of sign-ins, client views, file views and downloads, and all changes.

## Local development

Requires Node 24. No database to install: without `DATABASE_URL` the server uses an embedded Postgres (PGlite) in `data/pgdata`, and keeps uploads in `data/files`.

```bash
npm install
cp .env.example .env        # then set FILE_ENCRYPTION_KEY (command is in the file)
npm run create-user -- --email you@agency.com --name "Your Name" --role admin
npm run dev                  # http://localhost:5173
```

`create-user` prints a temporary password if you don't pass `--password`. Without `SMTP_*` settings, alert emails are logged to the console instead of being sent. To work against Supabase locally, fill in the Supabase settings in `.env`.

| Command | What it does |
| --- | --- |
| `npm test` | Unit and API tests (Vitest + Supertest, on an in-memory Postgres) |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run build` | Production build (`web/dist`, `server/dist`) |
| `npm run job:expiry` | Run the expiry check once |
| `npm run backup` | Write every table to `data/backups/crm-<time>.json` |
| `npm run copy-to-supabase -w server` | One-time copy of your local data and files into Supabase |
| `npm run import-sqlite -w server` | One-time copy of an old SQLite `data/crm.db` (from before the Postgres move) into the configured database |

## Deploying: GitHub + Supabase + Vercel

The code lives in a **private** GitHub repo; GitHub Actions runs the type check and tests on every push. **Supabase** holds the database (Postgres) and the encrypted files (a private Storage bucket). **Vercel** serves the web app and runs the API as a serverless function, redeploying automatically on every push to `main`.

On Vercel:
- The daily expiry and birthday check runs from a **Vercel Cron Job** (`vercel.json`, 03:00 UTC = 08:00 Pakistan time) instead of the time in *Alert settings*.
- Uploads are limited to **4 MB** (Vercel rejects larger requests). Elsewhere the limit is 15 MB; change it with `MAX_UPLOAD_MB`.

### 1. Supabase

1. In your Supabase project, open **Connect** and copy the **Transaction pooler** connection string (port **6543**; best for serverless). Put your database password in it. This is `DATABASE_URL`.
2. Optional: open **Project Settings → API** and copy the **Project URL** (`SUPABASE_URL`) and the **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`) to keep scans in Supabase Storage. Without them, scans are stored (encrypted) in the database's `stored_files` table. The service role key bypasses all security: keep it only in Vercel's environment settings and your local `.env`, never in the code or the browser.
3. Nothing else to set up: the server creates its tables (with Row Level Security on, so Supabase's public API can read nothing) and the private `crm-files` bucket on first start.

### 2. GitHub

Create a **private** repository (for example `syndic-crm`) and push the code. `.gitignore` keeps `.env`, `data/` (database, scans, dev logins) and build output out of the repo.

```bash
git init -b main
git add .
git commit -m "Syndic CRM"
git remote add origin https://github.com/<you>/syndic-crm.git
git push -u origin main
```

### 3. Vercel

1. Sign in to [Vercel](https://vercel.com) with GitHub, choose **Add New → Project** and import the repo. Leave the framework preset as **Other**; `vercel.json` sets the build.
2. Before the first deploy, add these **Environment Variables** (Production):
   - `DATABASE_URL` from step 1 (plus `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only if you use Storage)
   - `FILE_ENCRYPTION_KEY`: the **same** key as your local `.env`, or existing scans cannot be decrypted. **Keep a copy in a password manager.**
   - `CRON_SECRET`: a long random string (generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Vercel sends it with the daily cron call.
   - `APP_TIMEZONE=Asia/Karachi`, and `APP_URL` if you use a custom domain (otherwise the Vercel address is used for email links)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` for alert emails
3. Deploy. `vercel.json` puts the function in Mumbai (`bom1`); change `regions` to the Vercel region closest to your Supabase project.

### 4. Your data

Copy what you have locally (the embedded database and encrypted files) into Supabase. Stop `npm run dev` first, put the Supabase settings in your local `.env`, then:

```bash
npm run copy-to-supabase -w server
```

Or start empty and create the first administrator in Supabase from your PC (Supabase settings in `.env`):

```bash
npm run create-user -- --email you@agency.com --name "Your Name" --role admin
```

Then sign in, open **Alert settings**, click **Send me a test email**, and add employees under **Employees**. With Supabase settings in `.env`, `npm run dev` also works against the live data, so remove them again to go back to local data.
### Backups

Supabase's paid plans include daily database backups. `npm run backup` (with the Supabase settings in `.env`) also writes a JSON copy of every table to `data/backups`. Files in Storage are encrypted and need `FILE_ENCRYPTION_KEY`.

### Alternative: your own server

The Docker setup (`docker-compose.yml`, Caddy for HTTPS) still works on any small Linux VPS. With Supabase settings in `.env` it uses Supabase; without them it keeps everything in `./data` on the server (`LOCAL_STORAGE=true`), backed up by `deploy/backup.sh`.

## Project layout

```
server/   Express API (TypeScript), Postgres (Supabase or embedded PGlite), encrypted file storage, cron job
  src/db/index.ts           database connection, queries and transactions
  src/db/schema.ts          tables and versioned migrations, applied on start-up
  src/db/repo.ts            users, travellers (clients), documents, trash, audit
  src/db/companies.ts       companies
  src/db/trips.ts           trips, bookings, tickets, trip documents
  src/lib/files.ts          encryption and file storage (Supabase Storage or disk)
  src/jobs/expiryAlerts.ts  alert logic and email
  src/routes/               API endpoints
web/      React + Mantine UI (Vite)
deploy/   Caddyfile, backup script (Docker VPS setup)
vercel.json               Vercel build, routing, daily cron and security headers
api/index.mjs             Vercel serverless function (wraps server/src/vercel.ts)
.github/workflows/ci.yml  type check, tests and build on every push
```