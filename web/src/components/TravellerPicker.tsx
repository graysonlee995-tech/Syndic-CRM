import { useMemo, useState } from 'react';
import { Button, Group, Modal, MultiSelect, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { TravellerOption } from '../types';
import { ClientForm } from './ClientForm';
import { useTravellerOptions } from './ListKit';
import { useCan } from '../permissions';

interface Props {
  /** Selected traveller ids as strings. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** When set, only this company's travellers are offered (and new travellers join it). */
  companyId: string;
}

const fullName = (t: { first_name: string; last_name: string }) => `${t.first_name} ${t.last_name}`;

/**
 * Travellers multi-select with an "Add" button that opens the full traveller
 * form in a pop-up; the new traveller is then selected. With a company chosen,
 * only that company's travellers are listed.
 */
export function TravellerPicker({ value, onChange, companyId }: Props) {
  const options = useTravellerOptions();
  const mayAdd = useCan()('travellers', 'add');
  const [search, setSearch] = useState('');
  // The box clears its text when it loses focus (e.g. on clicking Add), so keep the last thing typed.
  const [typed, setTyped] = useState('');
  const [adding, setAdding] = useState(false);
  // Travellers created here, until the refreshed list includes them.
  const [created, setCreated] = useState<TravellerOption[]>([]);

  const data = useMemo(() => {
    const all = [...(options.data ?? [])];
    for (const c of created) if (!all.some((t) => t.id === c.id)) all.push(c);
    const selected = new Set(value);
    return all
      // Already-selected travellers always stay listed, so their names still show.
      .filter((t) => !companyId || String(t.company_id) === companyId || selected.has(String(t.id)))
      .map((t) => ({
        value: String(t.id),
        label: `${fullName(t)}${t.company_name && String(t.company_id) !== companyId ? ` (${t.company_name})` : ''}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [options.data, created, companyId, value]);

  return (
    <>
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <MultiSelect
          label="Travellers"
          placeholder={value.length ? undefined : companyId ? "Search this company's travellers" : 'Search travellers'}
          searchable
          clearable
          data={data}
          value={value}
          onChange={onChange}
          searchValue={search}
          onSearchChange={(text) => {
            setSearch(text);
            if (text.trim()) setTyped(text.trim());
          }}
          nothingFoundMessage={companyId ? 'No traveller of this company found. Use + Add to create one.' : 'No traveller found. Use + Add to create one.'}
          style={{ flex: 1 }}
        />
        <Tooltip label="Add a new traveller without leaving this page">
          <Button variant="default" leftSection={<IconPlus size={14} />} display={mayAdd ? undefined : 'none'} onClick={() => setAdding(true)}>
            Add
          </Button>
        </Tooltip>
      </Group>

      <Modal opened={adding} onClose={() => setAdding(false)} title="Add traveller" size="xl">
        {adding && (
          <ClientForm
            inModal
            initialCompanyId={companyId}
            initialName={typed}
            onSaved={(client) => {
              setCreated((list) => [...list, client]);
              onChange([...new Set([...value, String(client.id)])]);
              setSearch('');
              setTyped('');
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </Modal>
    </>
  );
}
