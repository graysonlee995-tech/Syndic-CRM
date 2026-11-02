import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, CopyButton, Group, Input, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';

/**
 * A traveller's Sabre entries: one line of text each, kept in order and saved
 * together in the traveller's sabre_entry field, one entry per line.
 */
export const sabreLines = (value: string | null | undefined) =>
  (value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' };

/** Small copy-to-clipboard icon for one entry. */
export function CopyLine({ value }: { value: string }) {
  return (
    <CopyButton value={value} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied' : 'Copy to clipboard'} withArrow>
          <ActionIcon size="sm" variant="subtle" color={copied ? 'green' : 'gray'} onClick={copy} aria-label="Copy to clipboard">
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

/** The entries on the traveller page, each with its own copy icon on the right. */
export function SabreEntriesList({ value }: { value: string | null }) {
  const lines = sabreLines(value);
  if (!lines.length) {
    return (
      <Text c="dimmed" size="sm">
        None yet. Add them with Edit.
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      {lines.map((line, i) => (
        <Group key={i} gap="xs" wrap="nowrap" align="flex-start" justify="space-between">
          <Text size="sm" style={{ ...MONO, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
            {line}
          </Text>
          <CopyLine value={line} />
        </Group>
      ))}
    </Stack>
  );
}

type Row = { key: number; text: string };
let nextKey = 1;
const toRows = (value: string) => {
  const lines = sabreLines(value);
  return (lines.length ? lines : ['']).map((text) => ({ key: nextKey++, text }));
};

/**
 * Editing the entries: one line each (long lines wrap on screen). Enter starts a
 * new entry below; pasting several lines adds one entry per line.
 */
export function SabreEntriesInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const focusKey = useRef<number | null>(null);
  const refs = useRef(new Map<number, HTMLTextAreaElement>());

  // Pick up a value loaded after the form opened (editing an existing traveller).
  useEffect(() => {
    if (sabreLines(value).join('\n') !== sabreLines(rows.map((r) => r.text).join('\n')).join('\n')) setRows(toRows(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (focusKey.current !== null) {
      refs.current.get(focusKey.current)?.focus();
      focusKey.current = null;
    }
  });

  const update = (next: Row[]) => {
    setRows(next);
    onChange(next.map((r) => r.text.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n'));
  };
  const insertAfter = (index: number, texts: string[]) => {
    const added = texts.map((text) => ({ key: nextKey++, text }));
    focusKey.current = added.at(-1)!.key;
    update([...rows.slice(0, index + 1), ...added, ...rows.slice(index + 1)]);
  };

  return (
    <Input.Wrapper label="Sabre Entries" description="One entry per line. Press Enter or Add line for the next one.">
      <Stack gap={6} mt={6}>
        {rows.map((row, i) => (
          <Group key={row.key} gap={4} wrap="nowrap" align="flex-start">
            <Textarea
              ref={(el) => {
                if (el) refs.current.set(row.key, el);
                else refs.current.delete(row.key);
              }}
              aria-label={`Sabre entry ${i + 1}`}
              placeholder={i === 0 ? 'e.g. -SMITH/JOHN MR' : undefined}
              autosize
              minRows={1}
              value={row.text}
              styles={{ input: MONO }}
              style={{ flex: 1 }}
              onChange={(e) => {
                const { value: text } = e.currentTarget;
                update(rows.map((r) => (r.key === row.key ? { ...r, text: text.replace(/\n/g, ' ') } : r)));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  insertAfter(i, ['']);
                }
              }}
              onPaste={(e) => {
                const lines = e.clipboardData.getData('text').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                if (lines.length < 2) return;
                e.preventDefault();
                const [first, ...rest] = lines;
                const merged = rows.map((r) => (r.key === row.key ? { ...r, text: (r.text ? `${r.text} ` : '') + first } : r));
                const added = rest.map((text) => ({ key: nextKey++, text }));
                focusKey.current = added.at(-1)!.key;
                update([...merged.slice(0, i + 1), ...added, ...merged.slice(i + 1)]);
              }}
            />
            <Group gap={0} wrap="nowrap" pt={4}>
              <CopyLine value={row.text} />
              <Tooltip label="Remove line" withArrow>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label="Remove line"
                  onClick={() => update(rows.length === 1 ? [{ key: nextKey++, text: '' }] : rows.filter((r) => r.key !== row.key))}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        ))}
        <Group>
          <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={() => insertAfter(rows.length - 1, [''])}>
            Add line
          </Button>
        </Group>
      </Stack>
    </Input.Wrapper>
  );
}
