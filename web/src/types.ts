export type Role = 'admin' | 'staff';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
  receives_alerts: boolean;
  totp_enabled: boolean;
  locked: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface ClientInput {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  gender: string | null;
  nationality: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  country: string | null;
  notes: string | null;
}

export interface Client extends ClientInput {
  id: number;
  created_at: string;
  updated_at: string;
}

export interface ClientListRow extends Client {
  document_count: number;
  earliest_expiry: string | null;
}

export const DOCUMENT_TYPES = [
  { value: 'passport', label: 'Passport' },
  { value: 'national_id', label: 'National ID card' },
  { value: 'driving_licence', label: 'Driving licence' },
  { value: 'visa', label: 'Visa' },
  { value: 'residence_permit', label: 'Residence permit' },
  { value: 'other', label: 'Other' },
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number]['value'];

export const documentLabel = (type: string) => DOCUMENT_TYPES.find((t) => t.value === type)?.label ?? type;

export interface ClientDocument {
  id: number;
  client_id: number;
  type: DocumentType;
  document_number: string | null;
  issuing_country: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  notes: string | null;
  file_name: string | null;
  original_name: string | null;
  mime_type: string | null;
  size: number | null;
  updated_at: string;
}

export interface ExpiringDocument {
  id: number;
  client_id: number;
  type: DocumentType;
  document_number: string | null;
  expiry_date: string;
  first_name: string;
  last_name: string;
  days_left: number;
}

export interface Settings {
  alertThresholds: number[];
  alertTime: string;
  birthdayReminders: boolean;
  birthdayDaysAhead: number;
}

export interface UpcomingBirthday {
  id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  date: string;
  days_until: number;
  age: number;
}

export interface AuditEntry {
  id: number;
  user_name: string | null;
  action: string;
  entity: string | null;
  entity_id: number | null;
  details: string | null;
  at: string;
}
