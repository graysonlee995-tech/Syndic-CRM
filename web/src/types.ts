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

/** A traveller. Stored as a "client" on the server. */
export interface ClientInput {
  first_name: string;
  last_name: string;
  company_id: number | null;
  date_of_birth: string | null;
  gender: string | null;
  nationality: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  country: string | null;
  seat_preference: string | null;
  meal_preference: string | null;
  cabin_preference: string | null;
  special_requirements: string | null;
  notes: string | null;
}

export interface Client extends ClientInput {
  id: number;
  company_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientListRow extends Client {
  document_count: number;
  earliest_expiry: string | null;
  upcoming_trips: number;
}

export interface TravellerOption {
  id: number;
  first_name: string;
  last_name: string;
  company_id: number | null;
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

export interface CompanyInput {
  name: string;
  primary_contact: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
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
  { value: 'planned', label: 'Planned' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

export const TRIP_FILTERS = [
  { value: 'all', label: 'All trips' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'past', label: 'Past / Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'open_tickets', label: 'Open tickets' },
] as const;

export type TripPhase = 'upcoming' | 'ongoing' | 'past' | 'cancelled';

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
}

export interface TripTraveller {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  company_id: number | null;
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

export const ITINERARY_TYPES = [
  { value: 'flight', label: 'Flight' },
  { value: 'hotel', label: 'Hotel' },
  { value: 'car', label: 'Car' },
  { value: 'cruise', label: 'Cruise' },
  { value: 'train', label: 'Train' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'other', label: 'Other' },
] as const;

export interface ItineraryItem {
  type: string;
  origin: string | null;
  destination: string | null;
  departure_date: string;
  departure_time: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  confirmation_number: string | null;
  gds_pnr: string | null;
}

export interface TripDetail {
  trip: Trip;
  travellers: TripTraveller[];
  itinerary: (ItineraryItem & { id: number })[];
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
