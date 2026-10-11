import { useEffect } from 'react';
import { Button, Center, Group, Loader, Text } from '@mantine/core';
import { IconArrowLeft, IconPrinter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { BOOKING_DEFS, BOOKING_KINDS } from '../components/bookings';
import { formatDate, formatDateTime, labelOf } from '../format';
import { TICKET_STATUSES, TRIP_TYPES, type Booking, type Flight, type TripDetail } from '../types';

interface AgendaItem {
  sortKey: string;
  when: string;
  kind: string;
  title: string;
  lines: string[];
}

/** Every booking as one dated line on the agenda, in time order. */
function agendaItems(data: TripDetail): AgendaItem[] {
  const items: AgendaItem[] = [];
  const name = (id: number) => {
    const t = data.travellers.find((x) => x.id === id);
    return t ? `${t.first_name} ${t.last_name}` : '';
  };
  for (const kind of BOOKING_KINDS) {
    const def = BOOKING_DEFS[kind];
    for (const b of data[kind] as (Booking | Flight)[]) {
      const [from, to] = def.when(b);
      const lines = def.fields
        .filter((f) => f.type !== 'date' && f.type !== 'datetime' && b[f.key] && !def.title(b).includes(String(b[f.key])))
        .map((f) => `${f.label}: ${String(b[f.key])}`);
      if (to) lines.unshift(`Until ${formatDateTime(to)}`);
      if (b.traveller_ids?.length) lines.push(`${def.people}: ${b.traveller_ids.map(name).filter(Boolean).join(', ')}`);
      if (kind === 'flights') {
        for (const k of (b as Flight).tickets) {
          lines.push(`Ticket ${k.ticket_number ?? '-'} · ${k.first_name} ${k.last_name} (${labelOf(TICKET_STATUSES, k.status)})`);
        }
      }
      items.push({
        sortKey: typeof from === 'string' && from ? from : '9999',
        when: formatDateTime(from),
        kind: def.singular,
        title: def.title(b),
        lines,
      });
    }
  }
  return items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

const css = `
  .agenda { max-width: 820px; margin: 0 auto; padding: 32px 24px; color: #111827; background: #fff; font-size: 14px; }
  .agenda h1 { font-size: 24px; margin: 4px 0 2px; }
  .agenda h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #0f766e; border-bottom: 2px solid #0f766e; padding-bottom: 4px; margin: 28px 0 10px; }
  .agenda table { width: 100%; border-collapse: collapse; }
  .agenda td, .agenda th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  .agenda th { font-size: 12px; color: #6b7280; font-weight: 600; }
  .agenda .muted { color: #6b7280; }
  .agenda .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px 16px; margin-top: 16px; }
  .agenda .meta div span { display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; font-weight: 600; }
  .agenda .item { break-inside: avoid; }
  @media print {
    .no-print { display: none !important; }
    body { background: #fff !important; }
    .agenda { padding: 0; }
  }
`;

export function TripAgendaPage() {
  const { id } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ['trip', id], queryFn: () => api<TripDetail>(`/trips/${id}`) });

  useEffect(() => {
    if (data) document.title = `${data.trip.reference} travel agenda`;
    return () => {
      document.title = 'Syndic CRM';
    };
  }, [data]);

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (error || !data) return <Text c="red">{(error as Error)?.message ?? 'Trip not found'}</Text>;
  const { trip, travellers, destinations } = data;
  const items = agendaItems(data);

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <style>{css}</style>
      <Group className="no-print" justify="space-between" p="md" style={{ borderBottom: '1px solid #e5e7eb', background: '#f9fafb' }}>
        <Button component={Link} to={`/trips/${trip.id}`} variant="default" leftSection={<IconArrowLeft size={16} />}>
          Back to trip
        </Button>
        <Group gap="xs">
          <Text size="sm" c="dimmed" visibleFrom="sm">
            Choose “Save as PDF” as the printer to download
          </Text>
          <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
            Print / Save as PDF
          </Button>
        </Group>
      </Group>

      <div className="agenda">
        <div className="muted">Travel agenda · {trip.reference}</div>
        <h1>{trip.name}</h1>
        {trip.company_name && <div>{trip.company_name}</div>}
        <div className="meta">
          <div>
            <span>From</span>
            {trip.origin ?? '-'}
          </div>
          <div>
            <span>Departure</span>
            {formatDate(trip.departure_date)}
          </div>
          <div>
            <span>Return</span>
            {formatDate(trip.return_date)}
          </div>
          <div>
            <span>Type</span>
            {labelOf(TRIP_TYPES, trip.trip_type)}
          </div>
        </div>

        <h2>Travellers</h2>
        {travellers.length ? (
          <table>
            <tbody>
              {travellers.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.first_name} {t.last_name}
                  </td>
                  <td className="muted">{t.phone ?? ''}</td>
                  <td className="muted">{t.email ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No travellers listed.</p>
        )}

        {destinations.length > 0 && (
          <>
            <h2>Destinations</h2>
            <table>
              <tbody>
                {destinations.map((d, i) => (
                  <tr key={d.id}>
                    <td style={{ width: 24 }}>{i + 1}.</td>
                    <td>{[d.city, d.country].filter(Boolean).join(', ')}</td>
                    <td className="muted">
                      {d.arrival_date || d.departure_date ? `${formatDate(d.arrival_date)} – ${formatDate(d.departure_date)}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h2>Itinerary</h2>
        {items.length ? (
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>When</th>
                <th style={{ width: 70 }}>Type</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="item">
                  <td>{item.when}</td>
                  <td className="muted">{item.kind}</td>
                  <td>
                    <strong>{item.title}</strong>
                    {item.lines.map((l, j) => (
                      <div key={j} className="muted">
                        {l}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No flights, hotels, cars or cruises booked yet.</p>
        )}

        {trip.notes && (
          <>
            <h2>Notes</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{trip.notes}</p>
          </>
        )}
      </div>
    </div>
  );
}
