import { useState } from 'react';
import { Button, Group, Modal, MultiSelect, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { CompanyForm } from './CompanyForm';
import { useCompanyOptions } from './ListKit';
import { useCan } from '../permissions';

interface Props {
  /** Selected company ids as strings. */
  value: string[];
  onChange: (companyIds: string[]) => void;
}

/**
 * The companies a traveller belongs to (any number, all equal), with an "Add"
 * button that opens the company form in a pop-up and adds the new company.
 */
export function CompanyMultiPicker({ value, onChange }: Props) {
  const companies = useCompanyOptions();
  const mayAdd = useCan()('companies', 'add');
  const [search, setSearch] = useState('');
  // The box clears its text when it loses focus (e.g. on clicking Add), so keep the last thing typed.
  const [typed, setTyped] = useState('');
  const [adding, setAdding] = useState(false);
  // Companies created here, until the refreshed list includes them.
  const [created, setCreated] = useState<{ value: string; label: string }[]>([]);
  const data = [...(companies.data ?? []), ...created.filter((c) => !companies.data?.some((o) => o.value === c.value))];

  return (
    <>
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <MultiSelect
          label="Companies"
          placeholder={value.length ? undefined : 'No company (individual)'}
          description="A traveller can belong to several companies"
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
          nothingFoundMessage="No company found. Use + Add to create it."
          style={{ flex: 1 }}
        />
        <Tooltip label="Add a new company without leaving this page">
          <Button variant="default" leftSection={<IconPlus size={14} />} display={mayAdd ? undefined : 'none'} onClick={() => setAdding(true)}>
            Add
          </Button>
        </Tooltip>
      </Group>

      <Modal opened={adding} onClose={() => setAdding(false)} title="Add company" size="lg">
        {adding && (
          <CompanyForm
            inModal
            initialName={typed}
            onSaved={(company) => {
              setCreated((list) => [...list, { value: String(company.id), label: company.name }]);
              onChange([...new Set([...value, String(company.id)])]);
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
