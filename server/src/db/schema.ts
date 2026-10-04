/**
 * Postgres schema (Supabase). Everything lives in its own "crm" schema, which
 * Supabase's public REST API does not expose, and row level security is on for
 * every table with no policies, so the only way in is through this server.
 *
 * Timestamps are stored as UTC text 'YYYY-MM-DD HH:MM:SS' (the format the app
 * and the web UI already use), so they sort and compare correctly as strings.
 */
export const NOW_SQL = `to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')`;

export const SCHEMA = /* sql */ `
CREATE SCHEMA IF NOT EXISTS crm;
SET search_path TO crm;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  totp_secret TEXT,
  totp_pending_secret TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  receives_alerts INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_SQL},
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT ${NOW_SQL},
  last_seen_at TEXT NOT NULL DEFAULT ${NOW_SQL}
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth TEXT,
  gender TEXT,
  nationality TEXT,
  phone TEXT,
  email TEXT,
  address_line TEXT,
  city TEXT,
  country TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW_SQL},
  updated_at TEXT NOT NULL DEFAULT ${NOW_SQL},
  -- Lower case, accent free words used by the search box (kept in sync by repo.reindexClient()).
  search_tokens TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_clients_dob ON clients(date_of_birth);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('passport', 'driving_licence', 'national_id', 'visa', 'residence_permit', 'other')),
  document_number TEXT,
  issuing_country TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  notes TEXT,
  file_name TEXT,
  original_name TEXT,
  mime_type TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW_SQL},
  updated_at TEXT NOT NULL DEFAULT ${NOW_SQL}
);
CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_id);
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON documents(expiry_date);

CREATE TABLE IF NOT EXISTS alert_log (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  threshold_days INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT ${NOW_SQL},
  PRIMARY KEY (document_id, threshold_days)
);

-- One reminder per client per birthday (year = year of that birthday)
CREATE TABLE IF NOT EXISTS birthday_log (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT ${NOW_SQL},
  PRIMARY KEY (client_id, year)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  at TEXT NOT NULL DEFAULT ${NOW_SQL}
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE birthday_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
`;
