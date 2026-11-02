import { Select, type ComboboxItem, type OptionsFilter } from '@mantine/core';
import { COUNTRIES, searchKey } from '../countries';

const DATA = [...COUNTRIES];

/**
 * Matches the code or anywhere in the name, ignoring case, accents and
 * punctuation. The country with that exact code comes first ("PK"), then names
 * starting with what was typed, then the rest.
 */
const filter: OptionsFilter = ({ options, search }) => {
  const q = searchKey(search.trim());
  if (!q) return options;
  const rank = (label: string) => {
    const k = searchKey(label); // "pk  pakistan"
    const [code, name] = [k.slice(0, 2), k.slice(2).trim()];
    return code === q ? 0 : name.startsWith(q) ? 1 : 2;
  };
  return (options as ComboboxItem[])
    .filter((o) => searchKey(o.label).includes(q))
    .sort((a, b) => rank(a.label) - rank(b.label));
};

/**
 * Country picker: only countries from the agency's IATA list ("PK - Pakistan")
 * can be chosen; typing a code or a name filters the list. A value saved before the list existed that is not on it
 * shows as empty, with a note, until a country is picked.
 */
export function CountrySelect({ value, onChange, label = 'Country' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const unknown = value && !DATA.includes(value as (typeof COUNTRIES)[number]) ? value : null;
  return (
    <Select
      label={label}
      placeholder="Type a code or name, e.g. PK"
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
