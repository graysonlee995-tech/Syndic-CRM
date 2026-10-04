# Syndic Travel CRM

A private CRM for a travel agency. Employees sign in to manage client records and their identity documents (passport, national ID, driving licence, visas), view scans, and get email alerts before documents expire.

## Features

- **Employee-only sign-in.** There is no public sign-up. Accounts lock for 15 minutes after 5 failed attempts, sessions time out after 8 idle hours, and employees can turn on two-factor authentication (an authenticator app) in *My account*.
- **Roles.**
  - **Staff** can view, search, add and edit clients, and upload and view documents.
  - **Admin** can also manage employees, choose who receives alerts, change alert settings, permanently delete clients and documents, and read the audit log.
- **Search** by name (partial words work), passport or ID number (with or without dashes), address, city, phone, email, or date of birth (`15/03/1985` or `1985-03-15`). You can also filter by date of birth, nationality and document type.
- **Document scans** (PDF, JPG, PNG, WEBP, up to 4 MB) are encrypted (AES-256-GCM) before they are stored and only served to signed-in employees. The file type is checked from the file's contents, not the name.
- **Expiry alerts.** A daily job (08:00 by default) emails one summary to every employee with *Receives alerts* switched on. By default it emails 90, 30 and 7 days before expiry and on the expiry day. Each step is sent once per document. Changing a document's expiry date (a renewal) starts its alerts over.
- **Birthday reminders.** The same daily job sends a separate email listing clients whose birthday is within 7 days (you can change this). Each client is included once per year. You can turn this off under *Alert settings*.
- **Dashboard** of expired documents, documents expiring within 7, 30 and 90 days, and client birthdays in the next 30 days.
- **Audit log** of sign-ins, client views, file views and downloads, and all changes.

## Hosting: Supabase + Vercel (free)

* **Supabase** holds everything: a Postgres database in a private `crm` schema (row level security on, not exposed by Supabase's public API), including the scans in the `files` table. Scans are encrypted by the server before they are stored, so the database only holds ciphertext. The app connects as its own `crm_app` login, which owns only the `crm` schema.
* **Vercel** runs the app: the React UI as static files and the Express API as a serverless function (`api/index.js`). **Vercel Cron** (`vercel.json`) calls `/api/cron/daily` every day at 03:00 UTC (08:00 Pakistan) for the expiry and birthday emails.
* Uploads are limited to **4 MB** per file because Vercel functions accept at most 4.5 MB per request.

### 1. Supabase

1. Create a project at supabase.com (free plan). Save the database password.
2. Click **Connect** (top bar) > **Connection string** > **Session pooler** and copy it. Replace `[YOUR-PASSWORD]` with the database password. This is `DATABASE_URL`.
3. **Project Settings > API**: copy the **Project URL** (`SUPABASE_URL`) and the **service_role** secret key (`SUPABASE_SERVICE_ROLE_KEY`). Never put the service role key anywhere except the server settings.

Tables and the `documents` bucket are created automatically on first use.

### 2. Vercel

1. **Add New > Project**, import this GitHub repository. Framework preset: **Other**. The build settings come from `vercel.json`.
2. Before deploying, add these **Environment Variables**:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Supabase session pooler string |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| `FILE_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` **Save a copy in a password manager.** Without it the scans can never be opened. |
| `CRON_SECRET` | any long random text |
| `IN_APP_SCHEDULER` | `false` |
| `NODE_ENV` | `production` |
| `APP_TIMEZONE` | `Asia/Karachi` |
| `APP_URL` | your Vercel address, e.g. `https://syndic-crm.vercel.app` |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_PASSWORD` | your first admin login (password 10+ characters) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | company mailbox for alert emails |

3. Deploy, open the site and sign in with the initial admin. Then delete `INITIAL_ADMIN_PASSWORD` in Vercel and change your password under **My account**.
4. Open **Alert settings**, click **Send me a test email**, and add employees under **Employees**.

For SMTP: Office 365 uses `smtp.office365.com`, port `587`, `SMTP_SECURE=false` (SMTP AUTH must be on for the mailbox). Google Workspace uses `smtp.gmail.com`, port `465`, `SMTP_SECURE=true` and an App Password.

Note: the daily email time is set by `vercel.json` (`0 3 * * *` in UTC). The *Alert time* setting in the app only applies when `IN_APP_SCHEDULER=true` on an always on server. On the Vercel free plan the cron fires once within that hour.

### Backups

Supabase's free plan has no downloadable backups. Export the database regularly, for example with `pg_dump "$DATABASE_URL" -n crm > crm-backup.sql`, and keep `FILE_ENCRYPTION_KEY` safe.

## Local development

Requires Node 22+ and a Postgres database (a free Supabase project works, or a local Postgres).

```bash
npm install
cp .env.example .env        # set DATABASE_URL and FILE_ENCRYPTION_KEY
npm run create-user -- --email you@agency.com --name "Your Name" --role admin
npm run dev                  # http://localhost:5173
```

Without `SUPABASE_URL` files are stored in `data/files`. Without `SMTP_*` settings, alert emails are logged to the console instead of being sent.

| Command | What it does |
| --- | --- |
| `npm test` | Unit and API tests (Vitest + Supertest). Needs a local Postgres; set `TEST_DATABASE_URL` if it is not `postgres://postgres:postgres@localhost:5432/postgres` |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run build` | Production build (`web/dist`, `server/dist`) |
| `npm run job:expiry` | Run the daily checks once |

## Project layout

```
api/      Vercel serverless entry point
server/   Express API (TypeScript), Postgres (Supabase), encrypted file storage (Supabase Storage), daily job
  src/db/repo.ts            all database access
  src/jobs/expiryAlerts.ts  alert logic and email
  src/routes/               API endpoints
web/      React + Mantine UI (Vite)
vercel.json  Vercel build, routing and daily cron
```
