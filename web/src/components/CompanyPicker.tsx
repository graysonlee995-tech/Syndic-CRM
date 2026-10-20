import { useState } from 'react';
import { Button, Group, Modal, Select, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { CompanyForm } from './CompanyForm';
import { useCompanyOptions } from './ListKit';

interface Props {
  /** Selected company id as a string, or '' for none. */
  value: string;
  onChange: (companyId: string) => void;
  placeholder?: string;
}

/**
 * Company dropdown with an "Add" button that opens the full company form in a
 * pop-up; the new company is then selected. What was typed in the search box
 * becomes the new company's name.
 */
export function CompanyPicker({ value, onChange, placeholder = 'No company' }: Props) {
  const companies = useCompanyOptions();
  const [search, setSearch] = useState('');
  // The box clears its text when it loses focus (e.g. on clicking Add), so keep the last thing typed.
  const [typed, setTyped] = useState('');
  const [adding, setAdding] = useState(false);
  const selectedLabel = companies.data?.find((c) => c.value === value)?.label;

  return (
    <>
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <Select
          label="Company"
          placeholder={placeholder}
          clearable
          searchable
          data={companies.data ?? []}
          value={value || null}
          onChange={(v) => onChange(v ?? '')}
          searchValue={search}
          onSearchChange={(text) => {
            setSearch(text);
            if (text.trim() && text !== selectedLabel) setTyped(text.trim());
          }}
          nothingFoundMessage="No company found. Use + Add to create it."
          style={{ flex: 1 }}
        />
        <Tooltip label="Add a new company without leaving this page">
          <Button variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
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
              onChange(String(company.id));
              setSearch(company.name);
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
