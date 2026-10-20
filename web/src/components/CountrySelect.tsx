import { Select, type ComboboxItem, type OptionsFilter } from '@mantine/core';
import { COUNTRIES, searchKey } from '../countries';

const DATA = [...COUNTRIES];

// Matches anywhere in the name, ignoring case, accents and punctuation.
const filter: OptionsFilter = ({ options, search }) => {
  const q = searchKey(search.trim());
  if (!q) return options;
  return (options as ComboboxItem[]).filter((o) => searchKey(o.label).includes(q));
};

/**
 * Country picker: only countries from the agency's list can be chosen; typing
 * filters the list. A value saved before the list existed that is not on it
 * shows as empty, with a note, until a country is picked.
 */
export function CountrySelect({ value, onChange, label = 'Country' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const unknown = value && !DATA.includes(value as (typeof COUNTRIES)[number]) ? value : null;
  return (
    <Select
      label={label}
      placeholder="Type to search"
      data={DATA}
      value={unknown ? null : value || null}
      onChange={(v) => onChange(v ?? '')}
      searchable
      clearable
      filter={filter}
      // The first match is highlighted while typing, so Enter picks it instead of submitting the form.
      selectFirstOptionOnChange
      nothingFoundMessage="No country matches. Only countries from the list can be chosen."
      maxDropdownHeight={280}
      error={unknown ? `"${unknown}" is not in the country list. Choose a country.` : undefined}
    />
  );
}
