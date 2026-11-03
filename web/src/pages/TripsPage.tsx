import { Button, Group, Stack, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { TripsTable } from '../components/TripsTable';
import { useCan } from '../permissions';

export function TripsPage() {
  const can = useCan();
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Trips</Title>
        {can('trips', 'add') && (
          <Button component={Link} to="/trips/new" leftSection={<IconPlus size={16} />}>
            Add trip
          </Button>
        )}
      </Group>
      <TripsTable urlBacked />
    </Stack>
  );
}
