import { Button, Checkbox, Group, Stack, Table, Text } from '@mantine/core';
import {
  ACTION_LABELS,
  ACTIONS,
  can,
  DEFAULT_STAFF_PERMISSIONS,
  SECTIONS,
  VIEW_ONLY_PERMISSIONS,
  type Action,
  type Permissions,
  type Section,
} from '../permissions';
import type { User } from '../types';

/**
 * A grid of sections x actions for a staff account. Ticking any action also
 * ticks View; unticking View clears the row. `granter` can only hand out what
 * they have themselves (admins have everything).
 */
export function PermissionsEditor({
  value,
  onChange,
  granter,
  disabled = false,
}: {
  value: Permissions;
  onChange: (p: Permissions) => void;
  granter: User | null | undefined;
  disabled?: boolean;
}) {
  const has = (s: Section, a: Action) => Boolean(value[s]?.includes(a));
  const toggle = (s: Section, a: Action, on: boolean) => {
    const current = new Set(value[s] ?? []);
    if (on) {
      current.add(a);
      current.add('view');
    } else if (a === 'view') {
      current.clear();
    } else {
      current.delete(a);
    }
    const next = { ...value };
    if (current.size) next[s] = ACTIONS.filter((x) => current.has(x));
    else delete next[s];
    onChange(next);
  };
  // Presets, trimmed to what the granter may give.
  const allowedOnly = (p: Permissions): Permissions =>
    Object.fromEntries(
      Object.entries(p)
        .map(([s, acts]) => [s, (acts ?? []).filter((a) => can(granter, s as Section, a))])
        .filter(([, acts]) => (acts as Action[]).length),
    );

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" fw={500}>
          Permissions
        </Text>
        <Group gap={6}>
          <Button size="compact-xs" variant="default" disabled={disabled} onClick={() => onChange(allowedOnly(DEFAULT_STAFF_PERMISSIONS))}>
            Standard staff
          </Button>
          <Button size="compact-xs" variant="default" disabled={disabled} onClick={() => onChange(allowedOnly(VIEW_ONLY_PERMISSIONS))}>
            View only
          </Button>
          <Button size="compact-xs" variant="default" disabled={disabled} onClick={() => onChange({})}>
            None
          </Button>
        </Group>
      </Group>
      <Table.ScrollContainer minWidth={520}>
        <Table withTableBorder striped verticalSpacing={4} fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Section</Table.Th>
              {ACTIONS.map((a) => (
                <Table.Th key={a} ta="center" w={64}>
                  {ACTION_LABELS[a]}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {SECTIONS.map((section) => (
              <Table.Tr key={section.key}>
                <Table.Td>
                  <Text size="sm">{section.label}</Text>
                  {'note' in section && section.note && (
                    <Text size="xs" c="dimmed">
                      {section.note}
                    </Text>
                  )}
                </Table.Td>
                {ACTIONS.map((a) => (
                  <Table.Td key={a} ta="center">
                    {(section.actions as readonly Action[]).includes(a) ? (
                      <Checkbox
                        aria-label={`${section.label}: ${ACTION_LABELS[a]}`}
                        checked={has(section.key, a)}
                        disabled={disabled || (!can(granter, section.key, a) && !has(section.key, a))}
                        onChange={(e) => toggle(section.key, a, e.currentTarget.checked)}
                        style={{ display: 'inline-block' }}
                      />
                    ) : (
                      <Text size="xs" c="dimmed">
                        –
                      </Text>
                    )}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
