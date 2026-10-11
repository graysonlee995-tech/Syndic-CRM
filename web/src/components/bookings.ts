import type { Booking } from '../types';

export type BookingKind = 'flights' | 'hotels' | 'cars' | 'cruises';

export interface BookingField {
  key: string;
  label: string;
  type?: 'text' | 'date' | 'datetime' | 'textarea' | 'select';
  options?: string[];
  required?: boolean;
  placeholder?: string;
}

export interface BookingDef {
  singular: string;
  plural: string;
  fields: BookingField[];
  /** Whether travellers are assigned on the booking itself (flights use tickets instead). */
  people: string | null;
  title: (b: Booking) => string;
  when: (b: Booking) => [unknown, unknown];
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** Mirrors BOOKINGS in server/src/db/trips.ts and bookingSchemas in server/src/routes/schemas.ts. */
export const BOOKING_DEFS: Record<BookingKind, BookingDef> = {
  flights: {
    singular: 'Flight',
    plural: 'Flights',
    people: null,
    fields: [
      { key: 'airline', label: 'Airline', placeholder: 'e.g. Emirates' },
      { key: 'flight_number', label: 'Flight number', placeholder: 'e.g. EK 601' },
      { key: 'from_airport', label: 'From', required: true, placeholder: 'e.g. KHI' },
      { key: 'to_airport', label: 'To', required: true, placeholder: 'e.g. DXB' },
      { key: 'departs_at', label: 'Departs', type: 'datetime' },
      { key: 'arrives_at', label: 'Arrives', type: 'datetime' },
      { key: 'cabin_class', label: 'Cabin', type: 'select', options: ['Economy', 'Premium economy', 'Business', 'First'] },
      { key: 'booking_reference', label: 'Booking reference (PNR)' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    title: (b) => `${[s(b.airline), s(b.flight_number)].filter(Boolean).join(' ') || 'Flight'} · ${s(b.from_airport)} → ${s(b.to_airport)}`,
    when: (b) => [b.departs_at, b.arrives_at],
  },
  hotels: {
    singular: 'Hotel',
    plural: 'Hotels',
    people: 'Guests',
    fields: [
      { key: 'name', label: 'Hotel', required: true },
      { key: 'city', label: 'City' },
      { key: 'address', label: 'Address' },
      { key: 'check_in', label: 'Check-in', type: 'date' },
      { key: 'check_out', label: 'Check-out', type: 'date' },
      { key: 'room_type', label: 'Room type' },
      { key: 'confirmation_number', label: 'Confirmation number' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    title: (b) => [s(b.name), s(b.city)].filter(Boolean).join(', '),
    when: (b) => [b.check_in, b.check_out],
  },
  cars: {
    singular: 'Car',
    plural: 'Cars',
    people: 'Passengers',
    fields: [
      { key: 'provider', label: 'Provider', required: true, placeholder: 'e.g. Hertz, private driver' },
      { key: 'car_type', label: 'Car type' },
      { key: 'pickup_location', label: 'Pick-up location' },
      { key: 'pickup_at', label: 'Pick-up', type: 'datetime' },
      { key: 'dropoff_location', label: 'Drop-off location' },
      { key: 'dropoff_at', label: 'Drop-off', type: 'datetime' },
      { key: 'confirmation_number', label: 'Confirmation number' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    title: (b) => [s(b.provider), s(b.car_type)].filter(Boolean).join(' · '),
    when: (b) => [b.pickup_at, b.dropoff_at],
  },
  cruises: {
    singular: 'Cruise',
    plural: 'Cruises',
    people: 'Passengers',
    fields: [
      { key: 'cruise_line', label: 'Cruise line', required: true },
      { key: 'ship', label: 'Ship' },
      { key: 'embark_port', label: 'Embark port' },
      { key: 'embark_date', label: 'Embark date', type: 'date' },
      { key: 'disembark_port', label: 'Disembark port' },
      { key: 'disembark_date', label: 'Disembark date', type: 'date' },
      { key: 'cabin', label: 'Cabin' },
      { key: 'confirmation_number', label: 'Confirmation number' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    title: (b) => [s(b.cruise_line), s(b.ship)].filter(Boolean).join(' · '),
    when: (b) => [b.embark_date, b.disembark_date],
  },
};

export const BOOKING_KINDS = Object.keys(BOOKING_DEFS) as BookingKind[];
