import { Text } from '@mantine/core';

/** A labelled read-only value on a profile page. */
export function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value || '-'}</Text>
    </div>
  );
}
