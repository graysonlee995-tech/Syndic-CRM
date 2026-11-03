import { Button, Group, Stack, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { TravellersTable } from '../components/TravellersTable';
import { useCan } from '../permissions';

/** The Travellers tab. Travellers are stored as clients on the server. */
export function ClientsPage() {
  const can = useCan();
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Travellers</Title>
        {can('travellers', 'add') && (
        <Button component={Link} to="/travellers/new" leftSection={<IconPlus size={16} />}>
          Add traveller
        </Button>
        )}
      </Group>
      <TravellersTable urlBacked />
    </Stack>
  );
}
