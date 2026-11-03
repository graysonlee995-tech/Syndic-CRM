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
  /** What this employee may do, per section (see permissions.tsx); admins have everything. */
  permissions: Partial<Record<string, string[]>>;
}

/** A traveller. Stored as a "client" on the server. */
export interface ClientInput {
  first_name: string;
  last_name: string;
  /** Every company the traveller belongs to (all equal). */
  company_ids: number[];
  date_of_birth: string | null;
  gender: string | null;
  nationality: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  state: string | null;
  city: string | null;
  country: string | null;
  seat_preference: string | null;
  meal_preference: string | null;
  cabin_preference: string | null;
  special_requirements: string | null;
  notes: string | null;
  /** Free text kept ready to paste into Sabre. */
  sabre_entry: string | null;
}

export interface Client extends ClientInput {
  id: number;
  /** 1 = active, 0 = inactive: an inactive traveller's documents raise no expiry alerts. */
  is_active: number;
  companies: { id: number; name: string }[];
  /** All company names, e.g. "ABC CORPORATION, XYZ LTD". */
  company_name: string | null;
  created_at: string;
  updated_at: string;
}

/** From the date of birth: infant under 2, child 2 to 11, adult 12 and over. */
export const PASSENGER_CATEGORIES = [
  { value: 'adult', label: 'Adult', color: 'gray' },
  { value: 'child', label: 'Child', color: 'cyan' },
  { value: 'infant', label: 'Infant', color: 'grape' },
] as const;

export interface ClientListRow extends Client {
  category: 'infant' | 'child' | 'adult' | 'unknown';
  document_count: number;
  earliest_expiry: string | null;
  upcoming_trips: number;
}

export interface TravellerOption {
  id: number;
  first_name: string;
  last_name: string;
  company_ids: number[];
  company_name: string | null;
}

export interface LoyaltyMembership {
  id: number;
  client_id: number;
  airline: string;
  programme: string | null;
  member_number: string;
  tier: string | null;
}

/** Extra emails, phone numbers and addresses of a company or traveller. */
export interface Contacts {
  emails: { id: number; label: string | null; email: string }[];
  phones: { id: number; label: string | null; number: string }[];
  addresses: { id: number; label: string | null; address_line: string | null; state: string | null; city: string | null; country: string | null }[];
}

export interface CompanyInput {
  name: string;
  primary_contact: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  state: string | null;
  city: string | null;
  country: string | null;
  notes: string | null;
}

export interface Company extends CompanyInput {
  id: number;
  created_at: string;
  updated_at: string;
}

export interface CompanyDocument {
  id: number;
  company_id: number;
  title: string;
  original_name: string | null;
  mime_type: string | null;
  size: number | null;
  created_at: string;
  uploaded_by_name: string | null;
}

export interface CompanyListRow extends Company {
  traveller_count: number;
  upcoming_trips: number;
}

export const TRIP_TYPES = [
  { value: 'business', label: 'Business' },
  { value: 'leisure', label: 'Leisure' },
  { value: 'group', label: 'Group' },
  { value: 'event', label: 'Event' },
  { value: 'other', label: 'Other' },
] as const;

export const TRIP_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

/** Recent: departs within the next 48 hours, departed within the last 24, or still underway. */
export const TRIP_FILTERS = [
  { value: 'all', label: 'All trips' },
  { value: 'recent', label: 'Recent' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

export type TripPhase = 'recent' | 'upcoming' | 'past' | 'inactive' | 'cancelled';

export interface Destination {
  city: string;
  country: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  notes: string | null;
}

export interface Trip {
  id: number;
  reference: string;
  name: string;
  company_id: number | null;
  company_name: string | null;
  origin: string | null;
  departure_date: string;
  return_date: string | null;
  trip_type: string;
  status: string;
  phase: TripPhase;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TripListRow extends Trip {
  destinations: string | null;
  traveller_names: string | null;
  traveller_count: number;
  open_tickets: number;
  /** 'passed', 'missing' (needs a quality check) or null (doesn't need one). */
  qc_status: 'passed' | 'missing' | null;
}

export interface TripTraveller {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  company_ids: number[];
  company_name: string | null;
  passport_expiry: string | null;
}

export const TICKET_STATUSES = [
  { value: 'issued', label: 'Issued' },
  { value: 'open', label: 'Open' },
  { value: 'used', label: 'Used' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'exchanged', label: 'Exchanged' },
  { value: 'void', label: 'Void' },
] as const;

export interface TicketResolution {
  id: number;
  resolution: string;
  notes: string | null;
  resolved_by_name: string | null;
  resolved_at: string;
}

export interface Ticket {
  id: number;
  flight_id: number;
  client_id: number;
  first_name: string;
  last_name: string;
  ticket_number: string | null;
  status: string;
  notes: string | null;
  resolutions: TicketResolution[];
}

/** A flight, hotel, car or cruise; its columns depend on the kind. */
export interface Booking {
  id: number;
  trip_id: number;
  traveller_ids?: number[];
  [field: string]: unknown;
}

export interface Flight extends Booking {
  tickets: Ticket[];
}

export interface TripDocument {
  id: number;
  trip_id: number;
  title: string;
  original_name: string | null;
  mime_type: string | null;
  size: number | null;
  created_at: string;
  uploaded_by_name: string | null;
}

/** Every kind of trip row; the itinerary section itself holds only flights and trains. */
export const ITINERARY_TYPES = [
  { value: 'flight', label: 'Flight' },
  { value: 'train', label: 'Train' },
  { value: 'hotel', label: 'Hotel' },
  { value: 'car', label: 'Car' },
  { value: 'other', label: 'Other' },
] as const;

export interface ItineraryItem {
  type: string;
  airline: string | null;
  flight_number: string | null;
  /** Hotel name, car company or an "other" item's description. */
  name: string | null;
  origin: string | null;
  destination: string | null;
  departure_date: string;
  departure_time: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  confirmation_number: string | null;
  gds_pnr: string | null;
}

export const CREDIT_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'used', label: 'Used' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'expired', label: 'Expired' },
] as const;

/** A flight, train or hotel taken off a trip as unused credit for one traveller. */
export interface OpenCredit extends ItineraryItem {
  id: number;
  trip_id: number;
  client_id: number;
  status: string;
  notes: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  created_at: string;
  trip_reference: string;
  trip_name: string;
  company_id: number | null;
  company_name: string | null;
  first_name: string;
  last_name: string;
}

export interface TripDetail {
  trip: Trip;
  travellers: TripTraveller[];
  itinerary: (ItineraryItem & { id: number })[];
  open_credits: OpenCredit[];
  qc: TripQc;
  destinations: (Destination & { id: number })[];
  flights: Flight[];
  hotels: Booking[];
  cars: Booking[];
  cruises: Booking[];
  documents: TripDocument[];
}

export interface TrashItem {
  kind: 'trip' | 'company' | 'client';
  id: number;
  label: string;
  detail: string | null;
  deleted_at: string;
}

export const DOCUMENT_TYPES = [
  { value: 'passport', label: 'Passport' },
  { value: 'residence_permit', label: 'Residence Card' },
  { value: 'visa', label: 'Visa' },
  { value: 'driving_licence', label: "Driver's License" },
  { value: 'ktn', label: 'KTN' },
  { value: 'other', label: 'Others' },
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number]['value'];

/** The type's name; an "Others" document shows what it is (e.g. "Vaccination certificate"). */
export const documentLabel = (type: string, otherType?: string | null) =>
  (type === 'other' && otherType) || DOCUMENT_TYPES.find((t) => t.value === type)?.label || type;

export interface ClientDocument {
  id: number;
  client_id: number;
  type: DocumentType;
  other_type: string | null;
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
  other_type: string | null;
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
  timezone: string;
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

export const QC_ANSWERS = [
  { value: 'verified', label: 'Verified', color: 'green' },
  { value: 'not_available', label: 'Not available', color: 'orange' },
  { value: 'not_required', label: 'Not required', color: 'gray' },
] as const;

export interface QcItem {
  id: number;
  label: string;
  position: number;
  is_active: boolean;
}

/** A trip's quality check. */
export interface TripQc {
  /** Whether the trip needs a check now (active and upcoming or ongoing). */
  due: boolean;
  status: 'passed' | 'missing' | null;
  passed_by_name: string | null;
  passed_at: string | null;
  items: { id: number; label: string; answer: string | null; answered_by_name: string | null; answered_at: string | null }[];
}

export interface QcListRow {
  id: number;
  reference: string;
  name: string;
  company_id: number | null;
  company_name: string | null;
  departure_date: string;
  return_date: string | null;
  traveller_names: string | null;
  qc_status: 'passed' | 'missing';
  answered: number;
  total: number;
  passed_by_name: string | null;
  passed_at: string | null;
}
