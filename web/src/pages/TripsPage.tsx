import { Button, Group, Stack, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { TripsTable } from '../components/TripsTable';

export function TripsPage() {
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Trips</Title>
        <Button component={Link} to="/trips/new" leftSection={<IconPlus size={16} />}>
          Add trip
        </Button>
      </Group>
      <TripsTable urlBacked />
    </Stack>
  );
}
